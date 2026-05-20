import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { EXIT_GATE_FAILURE } from '../../../../src/cli/exit-codes';
import { readTimelineEventsSummary, runBuildReviewContextCommand } from '../../../../src/cli/commands/gate-build-handlers';
import {
    runCompileGateCommand,
    runRestartCoherentCycleCommand,
    runRestartReviewCycleCommand as runRestartReviewCycleCommandRaw,
    runRequiredReviewsCheckCommand
} from '../../../../src/cli/commands/gates';
import { formatCompletionGateResult, runCompletionGate } from '../../../../src/gates/completion';
import { fileSha256, normalizePath, writeProtectedControlPlaneManifest } from '../../../../src/gates/helpers';
import { serializeTaskPlan, validateTaskPlan } from '../../../../src/schemas/task-plan';
import { buildReviewContext } from '../../../../src/gates/build-review-context';
import { buildScopedDiff } from '../../../../src/gates/build-scoped-diff';
import { buildReviewContextPreflightDiffExpectations } from '../../../../src/gates/review-context-contract';
import { buildReviewTreeState } from '../../../../src/gates/review-tree-state';
import {
    computeReviewRelevantScopeFingerprint,
    isNonTestReviewScope
} from '../../../../src/gates/review-reuse';
import { resolveRuntimeReviewerIdentity } from '../../../../src/gates/reviewer-routing';
import { getTaskModeEvidence } from '../../../../src/gates/task-mode';
import { getCurrentWorkflowConfigFileHashes } from '../../../../src/gates/workflow-config-work';
import { appendTaskEvent } from '../../../../src/gate-runtime/task-events';
import { withFilesystemLockAsync } from '../../../../src/gate-runtime/task-events-locking';
import { ensureSkillsHeadlinesCurrent } from '../../../../src/runtime/skill-headlines';
import { writeOptionalSkillSelectionArtifact } from '../../../../src/runtime/optional-skill-selection';
import {
    createTempRepo as createBaseTempRepo,
    getOrchestratorRoot,
    getReviewsRoot,
    initializeGitRepo,
    loadPostPreflightRulePack,
    loadTaskEntryRulePack,
    prepareReviewDiffFixture,
    readTaskTimelineEvents,
    runEnterTaskMode,
    runExplicitPreflight,
    runGit,
    runHandshakeForTask,
    runShellSmokeForTask,
    seedReusableReviewEvidence,
    writeCleanReviewArtifact,
    writeCompilePassEvidence,
    writeHandshakeArtifact,
    writePreflight,
    writeReceiptBackedReviewArtifact,
    writeReviewCapabilitiesConfig,
    writeShellSmokeArtifact,
    appendPreflightClassifiedEvent,
    findLastTimelineEventIndex
} from './gate-test-helpers';

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function markAsSourceCheckout(repoRoot: string): void {
    fs.writeFileSync(
        path.join(repoRoot, 'package.json'),
        JSON.stringify({ name: 'garda-agent-orchestrator' }, null, 2),
        'utf8'
    );
    fs.mkdirSync(path.join(repoRoot, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, 'bin', 'garda.js'), '#!/usr/bin/env node\n', 'utf8');
}

function readPreflightChangedFiles(preflightPath: unknown): string[] {
    const resolvedPath = String(preflightPath || '').trim();
    if (!resolvedPath || !fs.existsSync(resolvedPath)) {
        return [];
    }
    try {
        const preflight = JSON.parse(fs.readFileSync(resolvedPath, 'utf8')) as Record<string, unknown>;
        return Array.isArray(preflight.changed_files)
            ? preflight.changed_files.map((entry) => String(entry).replace(/\\/g, '/')).filter(Boolean)
            : [];
    } catch {
        return [];
    }
}

function buildDefaultRemediationImpactAnalysis(changedFiles: unknown, preflightPath: unknown): string {
    const normalizedChangedFiles = Array.isArray(changedFiles)
        ? changedFiles.map((entry) => String(entry).replace(/\\/g, '/')).filter(Boolean)
        : [];
    const knownFiles = [...new Set([...normalizedChangedFiles, ...readPreflightChangedFiles(preflightPath)])];
    const affectedFiles = knownFiles.length > 0
        ? knownFiles.join(', ')
        : 'src/app.ts, tests/app.test.ts';
    return [
        `Reviewer finding: failed review blocker requires a same-task remediation pass for ${affectedFiles}.`,
        `Intended fix: apply only the blocker fix in ${affectedFiles} and preserve the existing remediation scope boundary.`,
        `Affected files/contracts: ${affectedFiles} are the affected files; public contracts stay unchanged unless refreshed preflight proves otherwise.`,
        `API/runtime/artifact/test impact: ${affectedFiles} require refreshed preflight, rule-pack, compile evidence, review contexts, and test evidence.`,
        'Possible side effects: review reuse must fail closed if the remediation expands outside the failed review boundary.',
        'Required targeted checks: compile gate and the relevant review-cycle regression assertions must run after the fix.',
        'Scope or review-type changes: changed review requirements must come only from refreshed preflight evidence.',
        'Related blockers/follow-up: fix in scope only when covered by the same failed-review blocker, otherwise queue a separate follow-up.'
    ].join(' ');
}

function runRestartReviewCycleCommand(
    options: Parameters<typeof runRestartReviewCycleCommandRaw>[0]
): ReturnType<typeof runRestartReviewCycleCommandRaw> {
    return runRestartReviewCycleCommandRaw({
        impactAnalysis: buildDefaultRemediationImpactAnalysis(
            (options as Record<string, unknown>).changedFiles,
            (options as Record<string, unknown>).preflightPath
        ),
        ...options
    });
}

function createTempRepo(): string {
    const root = createBaseTempRepo();
    ensureSkillsHeadlinesCurrent(path.join(root, 'garda-agent-orchestrator'));
    return root;
}

function writeProfilesConfig(repoRoot: string): string {
    const configDir = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config');
    const configPath = path.join(configDir, 'profiles.json');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, 'paths.json'), JSON.stringify({
        triggers: {
            db: ['(^|/)db/'],
            security: ['.*'],
            refactor: ['.*'],
            api: ['(^|/)api/'],
            test: ['(^|/)tests?/'],
            performance: ['(^|/)perf/'],
            infra: ['(^|/)scripts/'],
            dependency: ['(^|/)package(-lock)?\\.json$']
        }
    }, null, 2) + '\n', 'utf8');
    fs.writeFileSync(configPath, JSON.stringify({
        version: 1,
        active_profile: 'balanced',
        built_in_profiles: {
            balanced: {
                depth: 2,
                review_policy: { code: true, db: 'auto', security: 'auto', refactor: 'auto' },
                token_economy: { enabled: true, strip_examples: true, strip_code_blocks: true, scoped_diffs: true, compact_reviewer_output: true },
                skills: { auto_suggest: true }
            },
            strict: {
                depth: 3,
                review_policy: { code: true, db: true, security: true, refactor: true },
                token_economy: { enabled: true, strip_examples: false, strip_code_blocks: false, scoped_diffs: true, compact_reviewer_output: false },
                skills: { auto_suggest: true }
            }
        },
        user_profiles: {}
    }, null, 2) + '\n', 'utf8');
    return configPath;
}

function prepareScopedDiffFixture(repoRoot: string, preflightPath: string, reviewType: string): void {
    const preflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
    const scopedDiffExpected = buildReviewContextPreflightDiffExpectations(preflight, reviewType).expectedScopedDiff;
    if (!scopedDiffExpected) {
        return;
    }
    prepareReviewDiffFixture(repoRoot, preflightPath);
    const reviewsRoot = getReviewsRoot(repoRoot);
    buildScopedDiff({
        reviewType,
        preflightPath,
        pathsConfigPath: path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'paths.json'),
        outputPath: path.join(reviewsRoot, `${preflight.task_id}-${reviewType}-scoped.diff`),
        metadataPath: path.join(reviewsRoot, `${preflight.task_id}-${reviewType}-scoped.json`),
        repoRoot
    });
}

function writeWorkflowConfig(
    repoRoot: string,
    reviewExecutionPolicyMode: 'parallel_all' | 'test_after_code' | 'code_first_optional' | 'strict_sequential' = 'code_first_optional'
): string {
    const configDir = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config');
    const configPath = path.join(configDir, 'workflow-config.json');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({
        full_suite_validation: {
            enabled: false,
            command: 'npm test',
            timeout_ms: 600000,
            green_summary_max_lines: 5,
            red_failure_chunk_lines: 50,
            out_of_scope_failure_policy: 'AUDIT_AND_BLOCK'
        },
        review_execution_policy: {
            mode: reviewExecutionPolicyMode
        }
    }, null, 2) + '\n', 'utf8');
    return configPath;
}

function seedNodeBackendOptionalSkillFixture(
    repoRoot: string,
    policyMode: 'advisory' | 'required' | 'strict' | 'off' = 'advisory'
): string {
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
            summary: 'Node backend specialist for request validation and API work.',
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
    fs.writeFileSync(path.join(skillRoot, 'SKILL.md'), '# Node Backend\n\nUse for Node backend API work.\n', 'utf8');
    return path.join(skillRoot, 'SKILL.md');
}

function seedTaskQueue(repoRoot: string, taskId: string, status = 'TODO', profile = 'default'): void {
    fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
        '| ID | Status | Priority | Area | Title | Assignee | Updated | Profile | Notes |',
        '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
        `| ${taskId} | ${status} | P1 | test | Update app flow | unassigned | 2026-03-28 | ${profile} | fixture |`
    ].join('\n'), 'utf8');
}

function seedInitAnswers(repoRoot: string, sourceOfTruth = 'Codex'): void {
    const initAnswersPath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'init-answers.json');
    fs.mkdirSync(path.dirname(initAnswersPath), { recursive: true });
    fs.writeFileSync(initAnswersPath, JSON.stringify({
        AssistantLanguage: 'English',
        AssistantBrevity: 'concise',
        SourceOfTruth: sourceOfTruth,
        EnforceNoAutoCommit: 'false',
        ClaudeOrchestratorFullAccess: 'false',
        TokenEconomyEnabled: 'true',
        CollectedVia: 'AGENT_INIT_PROMPT.md',
        ActiveAgentFiles: 'AGENTS.md'
    }, null, 2), 'utf8');
}

function seedRemediationRepoBase(repoRoot: string): void {
    fs.writeFileSync(path.join(repoRoot, '.gitignore'), 'TASK.md\ngarda-agent-orchestrator/runtime/\n', 'utf8');
    fs.writeFileSync(path.join(repoRoot, 'AGENTS.md'), '# AGENTS\n', 'utf8');
    fs.writeFileSync(path.join(repoRoot, 'VERSION'), '0.0.0-test\n', 'utf8');
    fs.mkdirSync(path.join(repoRoot, '.agents', 'workflows'), { recursive: true });
    fs.mkdirSync(path.join(repoRoot, 'garda-agent-orchestrator', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, '.agents', 'workflows', 'start-task.md'), '# start-task\n', 'utf8');
    fs.writeFileSync(path.join(repoRoot, 'garda-agent-orchestrator', 'bin', 'garda.js'), '#!/usr/bin/env node\n', 'utf8');
}

function writeSimpleCompileCommandsFile(
    repoRoot: string,
    suffix: string
): { commandsPath: string; outputFiltersPath: string } {
    const commandsPath = path.join(repoRoot, `commands-${suffix}.md`);
    const outputFiltersPath = path.resolve('live/config/output-filters.json');
    fs.writeFileSync(commandsPath, [
        '### Compile Gate (Mandatory)',
        '```bash',
        'node -e "console.log(\'build ok\')"',
        '```'
    ].join('\n'), 'utf8');
    return { commandsPath, outputFiltersPath };
}

describe('cli/commands/gates – review-cycle suites', () => {
    it('restarts the latest coherent cycle on a dirty tree while reusing the previous explicit preflight scope', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-903a-restart-coherent-cycle';
        fs.writeFileSync(path.join(repoRoot, '.gitignore'), 'TASK.md\ngarda-agent-orchestrator/runtime/\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, 'AGENTS.md'), '# AGENTS\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, 'VERSION'), '0.0.0-test\n', 'utf8');
        fs.mkdirSync(path.join(repoRoot, '.agents', 'workflows'), { recursive: true });
        fs.mkdirSync(path.join(repoRoot, 'garda-agent-orchestrator', 'bin'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, '.agents', 'workflows', 'start-task.md'), '# start-task\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, 'garda-agent-orchestrator', 'bin', 'garda.js'), '#!/usr/bin/env node\n', 'utf8');
        markAsSourceCheckout(repoRoot);
        writeProtectedControlPlaneManifest(repoRoot);
        initializeGitRepo(repoRoot);
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);
        const preflightPath = writePreflight(repoRoot, taskId, {
            metrics: { changed_lines_total: 3, changed_files_count: 1 },
            changed_files: ['src/app.ts'],
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
        const commandsPath = path.join(repoRoot, 'commands-restart-coherent-cycle.md');
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
            taskSummary: 'Restart the latest coherent cycle after misordered recovery noise',
            startBanner: 'Garda rewrites my code',
            orchestratorWork: true,
            operatorConfirmed: 'yes',
            operatorConfirmedAtUtc: new Date().toISOString()
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

        appendTaskEvent(
            getOrchestratorRoot(repoRoot),
            taskId,
            'REVIEW_PHASE_STARTED',
            'INFO',
            'Initial review phase started.',
            { review_type: 'code' }
        );
        appendTaskEvent(
            getOrchestratorRoot(repoRoot),
            taskId,
            'SKILL_SELECTED',
            'INFO',
            'Skill selected: code-review',
            { skill_id: 'code-review', trigger_reason: 'required_review' }
        );
        appendTaskEvent(
            getOrchestratorRoot(repoRoot),
            taskId,
            'SKILL_REFERENCE_LOADED',
            'INFO',
            'Reference loaded: garda-agent-orchestrator/live/skills/code-review/SKILL.md',
            {
                skill_id: 'code-review',
                reference_path: 'garda-agent-orchestrator/live/skills/code-review/SKILL.md',
                trigger_reason: 'review_skill'
            }
        );

        writeReceiptBackedReviewArtifact(repoRoot, taskId, 'code', 'REVIEW PASSED', undefined, {
            allowLegacyManualReviewContext: true
        });

        const firstReviewResult = runRequiredReviewsCheckCommand({
            repoRoot,
            taskId,
            preflightPath,
            codeReviewVerdict: 'REVIEW PASSED',
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(firstReviewResult.exitCode, 0);

        appendTaskEvent(
            getOrchestratorRoot(repoRoot),
            taskId,
            'PREFLIGHT_CLASSIFIED',
            'INFO',
            'New preflight started for a later cycle.',
            { mode: 'FULL_PATH', changed_files_count: 1, changed_lines_total: 3, required_reviews: { code: true } }
        );
        appendTaskEvent(
            getOrchestratorRoot(repoRoot),
            taskId,
            'IMPLEMENTATION_STARTED',
            'INFO',
            'Implementation started for later cycle.',
            {}
        );
        appendTaskEvent(
            getOrchestratorRoot(repoRoot),
            taskId,
            'REVIEW_PHASE_STARTED',
            'INFO',
            'Review phase started too early for later cycle.',
            { review_type: 'code' }
        );
        appendTaskEvent(
            getOrchestratorRoot(repoRoot),
            taskId,
            'COMPILE_GATE_PASSED',
            'PASS',
            'Compile gate passed too late in later cycle.',
            {}
        );
        appendTaskEvent(
            getOrchestratorRoot(repoRoot),
            taskId,
            'REVIEW_GATE_PASSED',
            'PASS',
            'Later review gate appeared to pass.',
            {}
        );

        const failedCompletion = runCompletionGate({
            repoRoot,
            preflightPath,
            taskId
        });
        assert.equal(failedCompletion.outcome, 'FAIL');

        fs.mkdirSync(path.join(repoRoot, 'docs'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'docs', 'noise.md'), 'unrelated dirty file\n', 'utf8');

        const restartResult = await runRestartCoherentCycleCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            operatorConfirmed: 'yes',
            operatorConfirmedAtUtc: new Date().toISOString(),
            emitMetrics: false
        });
        assert.equal(restartResult.exitCode, 0, restartResult.outputLines.join('\n'));
        assert.match(restartResult.outputLines.join('\n'), /COHERENT_CYCLE_RESTARTED/);
        assert.match(restartResult.outputLines.join('\n'), /DetectionSource: explicit_changed_files/);

        const refreshedPreflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
        assert.deepEqual(refreshedPreflight.changed_files, ['src/app.ts']);

        const events = readTaskTimelineEvents(repoRoot, taskId);
        const lastTaskModeIndex = findLastTimelineEventIndex(events, (event) => event.event_type === 'TASK_MODE_ENTERED');
        const lastHandshakeIndex = findLastTimelineEventIndex(events, (event) => event.event_type === 'HANDSHAKE_DIAGNOSTICS_RECORDED');
        const lastShellSmokeIndex = findLastTimelineEventIndex(events, (event) => event.event_type === 'SHELL_SMOKE_PREFLIGHT_RECORDED');
        const lastPreflightIndex = findLastTimelineEventIndex(events, (event) => event.event_type === 'PREFLIGHT_CLASSIFIED');
        const lastCompileIndex = findLastTimelineEventIndex(events, (event) => event.event_type === 'COMPILE_GATE_PASSED');
        assert.ok(lastTaskModeIndex >= 0);
        assert.ok(lastHandshakeIndex > lastTaskModeIndex);
        assert.ok(lastShellSmokeIndex > lastHandshakeIndex);
        assert.ok(lastPreflightIndex > lastShellSmokeIndex);
        assert.ok(lastCompileIndex > lastPreflightIndex);
        const lastTaskModeEvent = events[lastTaskModeIndex] as Record<string, unknown>;
        assert.equal(
            String((lastTaskModeEvent.details as Record<string, unknown>).start_banner || ''),
            'Garda rewrites my code'
        );
        const refreshedTaskModeArtifact = JSON.parse(fs.readFileSync(
            path.join(getReviewsRoot(repoRoot), `${taskId}-task-mode.json`),
            'utf8'
        )) as Record<string, unknown>;
        assert.equal(refreshedTaskModeArtifact.start_banner, 'Garda rewrites my code');
        assert.equal(refreshedTaskModeArtifact.orchestrator_work, true);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('restarts a coherent cycle from a legacy task-mode artifact without forcing a new start banner', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-903a-restart-coherent-cycle-legacy-task-mode';
        fs.writeFileSync(path.join(repoRoot, '.gitignore'), 'TASK.md\ngarda-agent-orchestrator/runtime/\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, 'AGENTS.md'), '# AGENTS\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, 'VERSION'), '0.0.0-test\n', 'utf8');
        fs.mkdirSync(path.join(repoRoot, '.agents', 'workflows'), { recursive: true });
        fs.mkdirSync(path.join(repoRoot, 'garda-agent-orchestrator', 'bin'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, '.agents', 'workflows', 'start-task.md'), '# start-task\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, 'garda-agent-orchestrator', 'bin', 'garda.js'), '#!/usr/bin/env node\n', 'utf8');
        initializeGitRepo(repoRoot);
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);

        fs.mkdirSync(getReviewsRoot(repoRoot), { recursive: true });
        const taskModePath = path.join(getReviewsRoot(repoRoot), `${taskId}-task-mode.json`);
        fs.writeFileSync(taskModePath, JSON.stringify({
            timestamp_utc: '2026-04-16T09:00:00.000Z',
            event_source: 'enter-task-mode',
            task_id: taskId,
            status: 'PASSED',
            outcome: 'PASS',
            entry_mode: 'EXPLICIT_TASK_EXECUTION',
            requested_depth: 2,
            effective_depth: 2,
            task_summary: 'Restart a coherent cycle from a legacy task-mode artifact after upgrade',
            workflow_config_file_hashes: getCurrentWorkflowConfigFileHashes(repoRoot),
            provider: 'Codex',
            routed_to: 'AGENTS.md'
        }, null, 2) + '\n', 'utf8');
        appendTaskEvent(getOrchestratorRoot(repoRoot), taskId, 'TASK_MODE_ENTERED', 'PASS', 'Legacy task-mode entry before restart.', {
            artifact_path: taskModePath.replace(/\\/g, '/'),
            entry_mode: 'EXPLICIT_TASK_EXECUTION',
            requested_depth: 2,
            effective_depth: 2,
            task_summary: 'Restart a coherent cycle from a legacy task-mode artifact after upgrade',
            provider: 'Codex',
            routed_to: 'AGENTS.md'
        });

        const preflightPath = writePreflight(repoRoot, taskId, {
            metrics: { changed_lines_total: 3, changed_files_count: 1 },
            changed_files: ['src/app.ts'],
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
        const commandsPath = path.join(repoRoot, 'commands-restart-coherent-cycle-legacy.md');
        const outputFiltersPath = path.resolve('live/config/output-filters.json');
        fs.writeFileSync(commandsPath, [
            '### Compile Gate (Mandatory)',
            '```bash',
            'node -e "console.log(\'build ok\')"',
            '```'
        ].join('\n'), 'utf8');

        const restartResult = await runRestartCoherentCycleCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(restartResult.exitCode, 0);
        assert.match(restartResult.outputLines.join('\n'), /COHERENT_CYCLE_RESTARTED/);

        const events = readTaskTimelineEvents(repoRoot, taskId);
        const taskModeEnteredEvents = events.filter((event) => event.event_type === 'TASK_MODE_ENTERED');
        assert.equal(taskModeEnteredEvents.length, 1);

        const refreshedTaskModeArtifact = JSON.parse(fs.readFileSync(taskModePath, 'utf8')) as Record<string, unknown>;
        assert.equal(Object.prototype.hasOwnProperty.call(refreshedTaskModeArtifact, 'start_banner'), false);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('restart-review-cycle reuses the latest coherent restart floor for legacy task-mode artifacts after an older review pass', { concurrency: false }, async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-903b-restart-review-cycle-legacy-coherent-floor';
        seedRemediationRepoBase(repoRoot);
        writeReviewCapabilitiesConfig(repoRoot);
        const { commandsPath, outputFiltersPath } = writeSimpleCompileCommandsFile(repoRoot, 'restart-review-cycle-legacy-coherent-floor');
        writeProtectedControlPlaneManifest(repoRoot);
        initializeGitRepo(repoRoot);
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');
        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'const a = 2;\nconst b = 3;\nconsole.log(a + b);\n', 'utf8');

        fs.mkdirSync(getReviewsRoot(repoRoot), { recursive: true });
        const taskModePath = path.join(getReviewsRoot(repoRoot), `${taskId}-task-mode.json`);
        fs.writeFileSync(taskModePath, JSON.stringify({
            timestamp_utc: '2026-04-16T09:00:00.000Z',
            event_source: 'enter-task-mode',
            task_id: taskId,
            status: 'PASSED',
            outcome: 'PASS',
            entry_mode: 'EXPLICIT_TASK_EXECUTION',
            requested_depth: 2,
            effective_depth: 2,
            task_summary: 'Restart the review cycle after a coherent restart from a legacy task-mode artifact',
            workflow_config_file_hashes: getCurrentWorkflowConfigFileHashes(repoRoot),
            provider: 'Codex',
            routed_to: 'AGENTS.md'
        }, null, 2) + '\n', 'utf8');
        appendTaskEvent(getOrchestratorRoot(repoRoot), taskId, 'TASK_MODE_ENTERED', 'PASS', 'Legacy task-mode entry before restart.', {
            artifact_path: taskModePath.replace(/\\/g, '/'),
            entry_mode: 'EXPLICIT_TASK_EXECUTION',
            requested_depth: 2,
            effective_depth: 2,
            task_summary: 'Restart the review cycle after a coherent restart from a legacy task-mode artifact',
            provider: 'Codex',
            routed_to: 'AGENTS.md'
        });

        loadTaskEntryRulePack(repoRoot, taskId, taskModePath);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        const preflightPath = runExplicitPreflight(
            repoRoot,
            taskId,
            'Restart the review cycle after a coherent restart from a legacy task-mode artifact',
            ['src/app.ts'],
            `${taskId}-preflight.json`,
            taskModePath
        );
        loadPostPreflightRulePack(repoRoot, taskId, preflightPath, true, '', taskModePath);

        const initialCompileResult = await runCompileGateCommand({
            repoRoot,
            taskId,
            taskModePath,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(initialCompileResult.exitCode, 0);
        appendTaskEvent(
            getOrchestratorRoot(repoRoot),
            taskId,
            'REVIEW_GATE_PASSED',
            'PASS',
            'Legacy review gate passed before coherent restart.',
            {}
        );

        const coherentRestartResult = await runRestartCoherentCycleCommand({
            repoRoot,
            taskId,
            taskModePath,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(coherentRestartResult.exitCode, 0, coherentRestartResult.outputLines.join('\n'));
        assert.match(coherentRestartResult.outputLines.join('\n'), /COHERENT_CYCLE_RESTARTED/);

        const reviewRestartResult = await runRestartReviewCycleCommand({
            repoRoot,
            taskId,
            taskModePath,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(reviewRestartResult.exitCode, 0, reviewRestartResult.outputLines.join('\n'));
        const output = reviewRestartResult.outputLines.join('\n');
        assert.match(output, /REVIEW_CYCLE_RESTARTED/);
        assert.match(output, /PreparedReviewTypes: code/);
        assert.match(output, /LaunchRequiredReviewTypes: code/);

        const events = readTaskTimelineEvents(repoRoot, taskId);
        const taskModeEnteredEvents = events.filter((event) => event.event_type === 'TASK_MODE_ENTERED');
        const taskEntryRulePackIndexes = events.reduce<number[]>((indexes, event, index) => {
            if (
                event.event_type === 'RULE_PACK_LOADED'
                && String((event.details as Record<string, unknown> | undefined)?.stage || '').toUpperCase() === 'TASK_ENTRY'
            ) {
                indexes.push(index);
            }
            return indexes;
        }, []);
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
        const reviewGateIndex = findLastTimelineEventIndex(events, (event) => event.event_type === 'REVIEW_GATE_PASSED');
        const lastCompileIndex = findLastTimelineEventIndex(events, (event) => event.event_type === 'COMPILE_GATE_PASSED');
        const lastCodeReviewPhaseIndex = findLastTimelineEventIndex(events, (event) => (
            event.event_type === 'REVIEW_PHASE_STARTED'
            && String((event.details as Record<string, unknown> | undefined)?.review_type || '').toLowerCase() === 'code'
        ));
        assert.equal(taskModeEnteredEvents.length, 1);
        assert.equal(taskEntryRulePackIndexes.length, 2);
        assert.equal(handshakeIndexes.length, 2);
        assert.equal(shellSmokeIndexes.length, 2);
        assert.ok(reviewGateIndex > taskEntryRulePackIndexes[0]);
        assert.ok(taskEntryRulePackIndexes[1] > reviewGateIndex);
        assert.ok(lastCompileIndex > shellSmokeIndexes[1]);
        assert.ok(lastCodeReviewPhaseIndex > lastCompileIndex);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('replays a prior git_auto scope as explicit changed files during coherent-cycle restart', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-903a-restart-coherent-cycle-git-auto';
        fs.writeFileSync(path.join(repoRoot, '.gitignore'), 'TASK.md\ngarda-agent-orchestrator/runtime/\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, 'AGENTS.md'), '# AGENTS\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, 'VERSION'), '0.0.0-test\n', 'utf8');
        fs.mkdirSync(path.join(repoRoot, '.agents', 'workflows'), { recursive: true });
        fs.mkdirSync(path.join(repoRoot, 'garda-agent-orchestrator', 'bin'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, '.agents', 'workflows', 'start-task.md'), '# start-task\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, 'garda-agent-orchestrator', 'bin', 'garda.js'), '#!/usr/bin/env node\n', 'utf8');
        initializeGitRepo(repoRoot);
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);

        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'const a = 2;\nconst b = 2;\nconsole.log(a + b);\nconsole.log(\'done\');\n', 'utf8');
        fs.mkdirSync(path.join(repoRoot, 'docs'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'docs', 'noise.md'), 'unrelated dirty file\n', 'utf8');

        const preflightPath = writePreflight(repoRoot, taskId, {
            detection_source: 'git_auto',
            metrics: { changed_lines_total: 3, changed_files_count: 1 },
            changed_files: ['src/app.ts'],
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
        const commandsPath = path.join(repoRoot, 'commands-restart-coherent-cycle-git-auto.md');
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
            taskSummary: 'Replay prior git_auto scope as explicit changed files during cycle restart'
        });

        const restartResult = await runRestartCoherentCycleCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(restartResult.exitCode, 0);
        assert.match(restartResult.outputLines.join('\n'), /DetectionSource: explicit_changed_files/);

        const refreshedPreflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
        assert.deepEqual(refreshedPreflight.changed_files, ['src/app.ts']);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('preserves git-auto zero-diff no-review classification during coherent-cycle restart', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-903a-restart-coherent-cycle-git-auto-zero';
        fs.writeFileSync(path.join(repoRoot, '.gitignore'), 'TASK.md\ngarda-agent-orchestrator/runtime/\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, 'AGENTS.md'), '# AGENTS\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, 'VERSION'), '0.0.0-test\n', 'utf8');
        fs.mkdirSync(path.join(repoRoot, '.agents', 'workflows'), { recursive: true });
        fs.mkdirSync(path.join(repoRoot, 'garda-agent-orchestrator', 'bin'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, '.agents', 'workflows', 'start-task.md'), '# start-task\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, 'garda-agent-orchestrator', 'bin', 'garda.js'), '#!/usr/bin/env node\n', 'utf8');
        initializeGitRepo(repoRoot);
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);

        const preflightPath = writePreflight(repoRoot, taskId, {
            detection_source: 'git_auto',
            metrics: { changed_lines_total: 0, changed_files_count: 0 },
            changed_files: [],
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
            },
            zero_diff_guard: {
                zero_diff_detected: true,
                status: 'BASELINE_ONLY',
                completion_requires_audited_no_op: true,
                no_op_artifact_suffix: '-no-op.json',
                rationale: 'Preflight on a clean workspace is baseline-only.'
            }
        });
        const commandsPath = path.join(
            getOrchestratorRoot(repoRoot),
            'runtime',
            'commands-restart-coherent-cycle-git-auto-zero.md'
        );
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
            taskSummary: 'Replay zero-diff git_auto scope during cycle restart'
        });

        const restartResult = await runRestartCoherentCycleCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(restartResult.exitCode, 0, restartResult.outputLines.join('\n'));
        assert.match(restartResult.outputLines.join('\n'), /DetectionSource: git_auto_current_workspace/);

        const refreshedPreflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
        assert.equal(refreshedPreflight.detection_source, 'git_auto');
        assert.deepEqual(refreshedPreflight.changed_files, []);
        assert.equal((refreshedPreflight.required_reviews as Record<string, boolean>).code, false);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('preserves approved task-plan metadata when coherent-cycle restart re-enters task mode', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-903a-restart-coherent-cycle-plan';
        fs.writeFileSync(path.join(repoRoot, '.gitignore'), 'TASK.md\ngarda-agent-orchestrator/runtime/\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, 'AGENTS.md'), '# AGENTS\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, 'VERSION'), '0.0.0-test\n', 'utf8');
        fs.mkdirSync(path.join(repoRoot, '.agents', 'workflows'), { recursive: true });
        fs.mkdirSync(path.join(repoRoot, 'garda-agent-orchestrator', 'bin'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, '.agents', 'workflows', 'start-task.md'), '# start-task\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, 'garda-agent-orchestrator', 'bin', 'garda.js'), '#!/usr/bin/env node\n', 'utf8');
        initializeGitRepo(repoRoot);
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);

        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'const a = 2;\nconst b = 2;\nconsole.log(a + b);\nconsole.log(\'done\');\n', 'utf8');
        const preflightPath = writePreflight(repoRoot, taskId, {
            detection_source: 'git_auto',
            metrics: { changed_lines_total: 3, changed_files_count: 1 },
            changed_files: ['src/app.ts'],
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
        const commandsPath = path.join(repoRoot, 'commands-restart-coherent-cycle-plan.md');
        const outputFiltersPath = path.resolve('live/config/output-filters.json');
        fs.writeFileSync(commandsPath, [
            '### Compile Gate (Mandatory)',
            '```bash',
            'node -e "console.log(\'build ok\')"',
            '```'
        ].join('\n'), 'utf8');

        const plan = validateTaskPlan({
            schema_version: 1,
            task_id: taskId,
            status: 'approved',
            goal: 'Restart the latest coherent task cycle safely',
            scope_files: ['src/app.ts'],
            risk_level: 'low',
            steps: [{ id: 'step-1', title: 'Replay the coherent cycle', files: ['src/app.ts'] }]
        });
        const planPath = path.join(getReviewsRoot(repoRoot), `${taskId}-task-plan.json`);
        fs.writeFileSync(planPath, serializeTaskPlan(plan), 'utf8');

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Restart the latest coherent cycle with approved plan metadata preserved',
            planPath,
            emitMetrics: false
        });

        const restartResult = await runRestartCoherentCycleCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(restartResult.exitCode, 0);

        const taskModeArtifact = JSON.parse(
            fs.readFileSync(path.join(getReviewsRoot(repoRoot), `${taskId}-task-mode.json`), 'utf8')
        ) as Record<string, unknown>;
        const planMetadata = taskModeArtifact.plan as Record<string, unknown> | null;
        assert.ok(planMetadata);
        assert.equal(planMetadata?.plan_path, planPath.replace(/\\/g, '/'));
        assert.equal(typeof planMetadata?.plan_sha256, 'string');
        assert.equal(planMetadata?.plan_summary, 'Restart the latest coherent task cycle safely');

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('restart-review-cycle refreshes the current diff and prepares only upstream reviews when downstream test review is still blocked', { concurrency: false }, async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-903b-restart-review-cycle-code-only';
        seedRemediationRepoBase(repoRoot);
        initializeGitRepo(repoRoot);
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Qwen');
        writeReviewCapabilitiesConfig(repoRoot);
        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'const a = 2;\nconst b = 2;\nconsole.log(a + b);\nconsole.log(\'done\');\n', 'utf8');
        fs.mkdirSync(path.join(repoRoot, 'tests'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'tests', 'app.test.ts'), 'it("works", () => {});\n', 'utf8');
        const { commandsPath, outputFiltersPath } = writeSimpleCompileCommandsFile(repoRoot, 'restart-review-cycle-code-only');

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Restart only the review cycle after a failed code review',
            plannedChangedFiles: [
                'commands-restart-review-cycle-code-only.md',
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
            'Restart only the review cycle after a failed code review',
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

        const restartResult = await runRestartReviewCycleCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            impactAnalysis: [
                'Reviewer finding: failed review blocker requires a same-task remediation pass for src/app.ts and tests/app.test.ts.',
                'Intended fix: refresh the changed implementation and test files without changing product behavior.',
                'Affected files/contracts: src/app.ts and tests/app.test.ts are the affected files; existing contracts stay unchanged.',
                'API/runtime/artifact/test impact: implementation and test evidence must be refreshed for this cycle.',
                'Possible side effects: review reuse must fail closed if unrelated behavior changes appear.',
                'Required targeted checks: compile gate and upstream code review context assertions cover the fix.',
                'Scope or review-type changes: test review stays blocked until code review passes for this cycle.',
                'Related blockers/follow-up: no separate follow-up is needed for this same blocker fix.'
            ].join(' '),
            emitMetrics: false
        });
        assert.equal(restartResult.exitCode, 0, restartResult.outputLines.join('\n'));

        const output = restartResult.outputLines.join('\n');
        assert.match(output, /REVIEW_CYCLE_RESTARTED/);
        assert.match(output, /PreparedReviewTypes: code/);
        assert.match(output, /LaunchRequiredReviewTypes: code/);
        assert.match(output, /PendingReviewTypes: test/);
        assert.match(output, /PendingReason: ReviewType 'test' is blocked until upstream reviews pass for the current cycle: code\./);
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
        const lastTestReviewPhaseIndex = findLastTimelineEventIndex(events, (event) => (
            event.event_type === 'REVIEW_PHASE_STARTED'
            && String((event.details as Record<string, unknown> | undefined)?.review_type || '').toLowerCase() === 'test'
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
        assert.ok(lastCodeReviewPhaseIndex === -1 || lastCodeReviewPhaseIndex > lastCompileIndex);
        assert.equal(lastTestReviewPhaseIndex, -1);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('restart-review-cycle blocks API review behind code under an explicit code_first_optional policy', { concurrency: false }, async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-903b-restart-review-cycle-api-after-code';
        seedRemediationRepoBase(repoRoot);
        writeWorkflowConfig(repoRoot, 'code_first_optional');
        initializeGitRepo(repoRoot);
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');
        writeReviewCapabilitiesConfig(repoRoot);
        fs.mkdirSync(path.join(repoRoot, 'src', 'routes'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'src', 'routes', 'app.ts'), 'export function handleAppRoute() { return "ok"; }\n', 'utf8');
        const { commandsPath, outputFiltersPath } = writeSimpleCompileCommandsFile(repoRoot, 'restart-review-cycle-api-after-code');

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Restart review cycle with API review blocked behind code by explicit policy',
            plannedChangedFiles: [
                'commands-restart-review-cycle-api-after-code.md',
                'src/routes/app.ts'
            ]
        });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        const preflightPath = runExplicitPreflight(
            repoRoot,
            taskId,
            'Restart review cycle with API review blocked behind code by explicit policy',
            ['src/routes/app.ts']
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
            impactAnalysis: [
                'Reviewer finding: failed review blocker changes the public API surface in src/routes/app.ts.',
                'Intended fix: update the exported route API contract in src/routes/app.ts and refresh review evidence.',
                'Affected files/contracts: src/routes/app.ts is the affected file and its public API contract changes.',
                'API/runtime/artifact/test impact: public API surface changes require code review before API review.',
                'Possible side effects: downstream route callers may rely on the previous exported contract.',
                'Required targeted checks: compile gate and review-cycle dependency assertions cover the fix.',
                'Scope or review-type changes: API review remains blocked until code review passes in this policy.',
                'Related blockers/follow-up: no separate follow-up is needed for this same blocker fix.'
            ].join(' '),
            emitMetrics: false
        });
        assert.equal(restartResult.exitCode, 0, restartResult.outputLines.join('\n'));

        const output = restartResult.outputLines.join('\n');
        assert.match(output, /REVIEW_CYCLE_RESTARTED/);
        assert.match(output, /ReviewExecutionPolicy: code_first_optional/);
        assert.match(output, /PreparedReviewTypes: code/);
        assert.match(output, /LaunchRequiredReviewTypes: code/);
        assert.match(output, /PendingReviewTypes: api/);
        assert.match(output, /PendingReason: ReviewType 'api' is blocked until upstream reviews pass for the current cycle: code\./);
        assert.equal(
            fs.existsSync(path.join(getReviewsRoot(repoRoot), `${taskId}-code-review-context.json`)),
            true
        );
        assert.equal(
            fs.existsSync(path.join(getReviewsRoot(repoRoot), `${taskId}-api-review-context.json`)),
            false
        );

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('restart-review-cycle keeps legacy compatibility when review_execution_policy is still omitted', { concurrency: false }, async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-903b-restart-review-cycle-legacy-compat';
        seedRemediationRepoBase(repoRoot);
        fs.mkdirSync(path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config'), { recursive: true });
        fs.writeFileSync(
            path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json'),
            JSON.stringify({
                full_suite_validation: {
                    enabled: false,
                    command: 'npm test',
                    timeout_ms: 600000,
                    green_summary_max_lines: 5,
                    red_failure_chunk_lines: 50,
                    out_of_scope_failure_policy: 'AUDIT_AND_BLOCK'
                }
            }, null, 2) + '\n',
            'utf8'
        );
        initializeGitRepo(repoRoot);
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');
        writeReviewCapabilitiesConfig(repoRoot);
        fs.mkdirSync(path.join(repoRoot, 'src', 'routes'), { recursive: true });
        fs.mkdirSync(path.join(repoRoot, 'tests'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'src', 'routes', 'app.ts'), 'export function handleAppRoute() { return "ok"; }\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, 'tests', 'app.test.ts'), 'it("works", () => {});\n', 'utf8');
        const { commandsPath, outputFiltersPath } = writeSimpleCompileCommandsFile(repoRoot, 'restart-review-cycle-legacy-compat');

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Restart review cycle with legacy compatibility while review_execution_policy is still omitted',
            plannedChangedFiles: [
                'commands-restart-review-cycle-legacy-compat.md',
                'src/routes/app.ts',
                'tests/app.test.ts'
            ]
        });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        const preflightPath = runExplicitPreflight(
            repoRoot,
            taskId,
            'Restart review cycle with legacy compatibility while review_execution_policy is still omitted',
            ['src/routes/app.ts', 'tests/app.test.ts']
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
            emitMetrics: false
        });
        assert.equal(restartResult.exitCode, 0, restartResult.outputLines.join('\n'));

        const output = restartResult.outputLines.join('\n');
        assert.match(output, /REVIEW_CYCLE_RESTARTED/);
        assert.match(output, /ReviewExecutionPolicy: legacy_test_downstream/);
        assert.match(output, /PreparedReviewTypes: code, api/);
        assert.match(output, /LaunchRequiredReviewTypes: code, api/);
        assert.match(output, /PendingReviewTypes: test/);
        assert.match(output, /PendingReason: ReviewType 'test' is blocked until upstream reviews pass for the current cycle: code, api\./);
        assert.equal(
            fs.existsSync(path.join(getReviewsRoot(repoRoot), `${taskId}-code-review-context.json`)),
            true
        );
        assert.equal(
            fs.existsSync(path.join(getReviewsRoot(repoRoot), `${taskId}-api-review-context.json`)),
            true
        );
        assert.equal(
            fs.existsSync(path.join(getReviewsRoot(repoRoot), `${taskId}-test-review-context.json`)),
            false
        );

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('restart-review-cycle prepares code, API, and test together under parallel_all policy', { concurrency: false }, async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-903b-restart-review-cycle-parallel-all';
        seedRemediationRepoBase(repoRoot);
        writeWorkflowConfig(repoRoot, 'parallel_all');
        initializeGitRepo(repoRoot);
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');
        writeReviewCapabilitiesConfig(repoRoot);
        fs.mkdirSync(path.join(repoRoot, 'src', 'routes'), { recursive: true });
        fs.mkdirSync(path.join(repoRoot, 'tests'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'src', 'routes', 'app.ts'), 'export function handleAppRoute() { return "ok"; }\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, 'tests', 'app.test.ts'), 'it("works", () => {});\n', 'utf8');
        const { commandsPath, outputFiltersPath } = writeSimpleCompileCommandsFile(repoRoot, 'restart-review-cycle-parallel-all');

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Restart review cycle with all required reviews independent under parallel_all',
            plannedChangedFiles: [
                'commands-restart-review-cycle-parallel-all.md',
                'src/routes/app.ts',
                'tests/app.test.ts'
            ]
        });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        const preflightPath = runExplicitPreflight(
            repoRoot,
            taskId,
            'Restart review cycle with all required reviews independent under parallel_all',
            ['src/routes/app.ts', 'tests/app.test.ts']
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
            emitMetrics: false
        });
        assert.equal(restartResult.exitCode, 0, restartResult.outputLines.join('\n'));

        const output = restartResult.outputLines.join('\n');
        assert.match(output, /REVIEW_CYCLE_RESTARTED/);
        assert.match(output, /ReviewExecutionPolicy: parallel_all/);
        assert.match(output, /PreparedReviewTypes: code, api, test/);
        assert.match(output, /LaunchRequiredReviewTypes: code, api, test/);
        assert.doesNotMatch(output, /PendingReviewTypes:/);
        assert.equal(
            fs.existsSync(path.join(getReviewsRoot(repoRoot), `${taskId}-code-review-context.json`)),
            true
        );
        assert.equal(
            fs.existsSync(path.join(getReviewsRoot(repoRoot), `${taskId}-api-review-context.json`)),
            true
        );
        assert.equal(
            fs.existsSync(path.join(getReviewsRoot(repoRoot), `${taskId}-test-review-context.json`)),
            true
        );
        const timelineEvents = readTaskTimelineEvents(repoRoot, taskId);
        const reviewPhaseEvents = timelineEvents.filter((event) => event.event_type === 'REVIEW_PHASE_STARTED');
        const selectedEvents = timelineEvents.filter((event) => event.event_type === 'SKILL_SELECTED');
        const referenceEvents = timelineEvents.filter((event) => event.event_type === 'SKILL_REFERENCE_LOADED');
        assert.deepEqual(
            reviewPhaseEvents.map((event) => String((event.details as Record<string, unknown>).review_type)).sort(),
            ['api', 'code', 'test']
        );
        assert.deepEqual(
            selectedEvents.map((event) => String((event.details as Record<string, unknown>).skill_id)).sort(),
            ['api-review', 'code-review', 'test-review']
        );
        assert.equal(
            referenceEvents.filter((event) => (
                String((event.details as Record<string, unknown>).trigger_reason) === 'review_context_artifact'
            )).length,
            3
        );

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('restart-review-cycle includes performance review preparation when parallel_all scope crosses the heuristic threshold', { concurrency: false }, async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-903b-restart-review-cycle-parallel-all-performance';
        seedRemediationRepoBase(repoRoot);
        writeWorkflowConfig(repoRoot, 'parallel_all');
        initializeGitRepo(repoRoot);
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');
        writeReviewCapabilitiesConfig(repoRoot);
        fs.mkdirSync(path.join(repoRoot, 'src', 'routes'), { recursive: true });
        fs.mkdirSync(path.join(repoRoot, 'tests'), { recursive: true });
        fs.writeFileSync(
            path.join(repoRoot, 'src', 'routes', 'heavy.ts'),
            Array.from({ length: 160 }, (_, index) => `export const route_${index} = ${index};`).join('\n') + '\n',
            'utf8'
        );
        fs.writeFileSync(path.join(repoRoot, 'tests', 'heavy.test.ts'), 'it("works", () => {});\n', 'utf8');
        const { commandsPath, outputFiltersPath } = writeSimpleCompileCommandsFile(repoRoot, 'restart-review-cycle-parallel-all-performance');

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Restart review cycle with performance required under parallel_all',
            plannedChangedFiles: [
                'commands-restart-review-cycle-parallel-all-performance.md',
                'src/routes/heavy.ts',
                'tests/heavy.test.ts'
            ]
        });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        const preflightPath = runExplicitPreflight(
            repoRoot,
            taskId,
            'Restart review cycle with performance required under parallel_all',
            ['src/routes/heavy.ts', 'tests/heavy.test.ts']
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
            emitMetrics: false
        });
        assert.equal(restartResult.exitCode, 0, restartResult.outputLines.join('\n'));

        const output = restartResult.outputLines.join('\n');
        assert.match(output, /ReviewExecutionPolicy: parallel_all/);
        assert.match(output, /PreparedReviewTypes: code, api, performance, test/);
        assert.match(output, /LaunchRequiredReviewTypes: code, api, performance, test/);
        assert.equal(
            fs.existsSync(path.join(getReviewsRoot(repoRoot), `${taskId}-performance-review-context.json`)),
            true
        );

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('restart-review-cycle keeps test downstream of code while leaving API independent under test_after_code policy', { concurrency: false }, async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-903b-restart-review-cycle-test-after-code';
        seedRemediationRepoBase(repoRoot);
        writeWorkflowConfig(repoRoot, 'test_after_code');
        initializeGitRepo(repoRoot);
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');
        writeReviewCapabilitiesConfig(repoRoot);
        fs.mkdirSync(path.join(repoRoot, 'src', 'routes'), { recursive: true });
        fs.mkdirSync(path.join(repoRoot, 'tests'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'src', 'routes', 'app.ts'), 'export function handleAppRoute() { return "ok"; }\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, 'tests', 'app.test.ts'), 'it("works", () => {});\n', 'utf8');
        const { commandsPath, outputFiltersPath } = writeSimpleCompileCommandsFile(repoRoot, 'restart-review-cycle-test-after-code');

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Restart review cycle with test blocked only behind code under test_after_code',
            plannedChangedFiles: [
                'commands-restart-review-cycle-test-after-code.md',
                'src/routes/app.ts',
                'tests/app.test.ts'
            ]
        });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        const preflightPath = runExplicitPreflight(
            repoRoot,
            taskId,
            'Restart review cycle with test blocked only behind code under test_after_code',
            ['src/routes/app.ts', 'tests/app.test.ts']
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
            emitMetrics: false
        });
        assert.equal(restartResult.exitCode, 0, restartResult.outputLines.join('\n'));

        const output = restartResult.outputLines.join('\n');
        assert.match(output, /REVIEW_CYCLE_RESTARTED/);
        assert.match(output, /ReviewExecutionPolicy: test_after_code/);
        assert.match(output, /PreparedReviewTypes: code, api/);
        assert.match(output, /LaunchRequiredReviewTypes: code, api/);
        assert.match(output, /PendingReviewTypes: test/);
        assert.match(output, /PendingReason: ReviewType 'test' is blocked until upstream reviews pass for the current cycle: code\./);
        assert.equal(
            fs.existsSync(path.join(getReviewsRoot(repoRoot), `${taskId}-code-review-context.json`)),
            true
        );
        assert.equal(
            fs.existsSync(path.join(getReviewsRoot(repoRoot), `${taskId}-api-review-context.json`)),
            true
        );
        assert.equal(
            fs.existsSync(path.join(getReviewsRoot(repoRoot), `${taskId}-test-review-context.json`)),
            false
        );

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('restart-review-cycle serializes downstream review preparation under strict_sequential policy', { concurrency: false }, async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-903b-restart-review-cycle-strict-sequential';
        seedRemediationRepoBase(repoRoot);
        writeWorkflowConfig(repoRoot, 'strict_sequential');
        initializeGitRepo(repoRoot);
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');
        writeReviewCapabilitiesConfig(repoRoot);
        fs.mkdirSync(path.join(repoRoot, 'src', 'routes'), { recursive: true });
        fs.mkdirSync(path.join(repoRoot, 'tests'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'src', 'routes', 'app.ts'), 'export function handleAppRoute() { return "ok"; }\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, 'tests', 'app.test.ts'), 'it("works", () => {});\n', 'utf8');
        const { commandsPath, outputFiltersPath } = writeSimpleCompileCommandsFile(repoRoot, 'restart-review-cycle-strict-sequential');

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Restart review cycle with downstream reviews serialized under strict_sequential',
            plannedChangedFiles: [
                'commands-restart-review-cycle-strict-sequential.md',
                'src/routes/app.ts',
                'tests/app.test.ts'
            ]
        });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        const preflightPath = runExplicitPreflight(
            repoRoot,
            taskId,
            'Restart review cycle with downstream reviews serialized under strict_sequential',
            ['src/routes/app.ts', 'tests/app.test.ts']
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
            emitMetrics: false
        });
        assert.equal(restartResult.exitCode, 0, restartResult.outputLines.join('\n'));

        const output = restartResult.outputLines.join('\n');
        assert.match(output, /REVIEW_CYCLE_RESTARTED/);
        assert.match(output, /ReviewExecutionPolicy: strict_sequential/);
        assert.match(output, /PreparedReviewTypes: code/);
        assert.match(output, /LaunchRequiredReviewTypes: code/);
        assert.match(output, /PendingReviewTypes: api, test/);
        assert.match(output, /PendingReason: ReviewType 'api' is blocked until upstream reviews pass for the current cycle: code\./);
        assert.equal(
            fs.existsSync(path.join(getReviewsRoot(repoRoot), `${taskId}-code-review-context.json`)),
            true
        );
        assert.equal(
            fs.existsSync(path.join(getReviewsRoot(repoRoot), `${taskId}-api-review-context.json`)),
            false
        );
        assert.equal(
            fs.existsSync(path.join(getReviewsRoot(repoRoot), `${taskId}-test-review-context.json`)),
            false
        );

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('restarts the latest coherent cycle with a custom task-mode artifact path', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-903a-restart-coherent-cycle-custom-task-mode';
        const customTaskModePath = path.join(
            repoRoot,
            'garda-agent-orchestrator',
            'runtime',
            'custom-artifacts',
            `${taskId}-task-mode.json`
        );
        fs.writeFileSync(path.join(repoRoot, '.gitignore'), 'TASK.md\ngarda-agent-orchestrator/runtime/\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, 'AGENTS.md'), '# AGENTS\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, 'VERSION'), '0.0.0-test\n', 'utf8');
        fs.mkdirSync(path.join(repoRoot, '.agents', 'workflows'), { recursive: true });
        fs.mkdirSync(path.join(repoRoot, 'garda-agent-orchestrator', 'bin'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, '.agents', 'workflows', 'start-task.md'), '# start-task\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, 'garda-agent-orchestrator', 'bin', 'garda.js'), '#!/usr/bin/env node\n', 'utf8');
        initializeGitRepo(repoRoot);
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);
        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'const a = 2;\nconst b = 2;\nconsole.log(a + b);\nconsole.log(\'done\');\n', 'utf8');
        const commandsPath = path.join(repoRoot, 'commands-restart-coherent-cycle-custom-task-mode.md');
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
            artifactPath: customTaskModePath,
            taskSummary: 'Restart the latest coherent cycle with a custom task-mode artifact path'
        });
        loadTaskEntryRulePack(repoRoot, taskId, customTaskModePath);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        const preflightPath = runExplicitPreflight(
            repoRoot,
            taskId,
            'Restart the latest coherent cycle with a custom task-mode artifact path',
            ['src/app.ts'],
            `${taskId}-preflight.json`,
            customTaskModePath
        );
        loadPostPreflightRulePack(repoRoot, taskId, preflightPath, true, '', customTaskModePath);

        const compileResult = await runCompileGateCommand({
            repoRoot,
            taskId,
            taskModePath: customTaskModePath,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(compileResult.exitCode, 0);

        const restartResult = await runRestartCoherentCycleCommand({
            repoRoot,
            taskId,
            taskModePath: customTaskModePath,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(restartResult.exitCode, 0, restartResult.outputLines.join('\n'));
        assert.match(restartResult.outputLines.join('\n'), /COHERENT_CYCLE_RESTARTED/);
        assert.match(
            restartResult.outputLines.join('\n'),
            new RegExp(escapeRegExp(customTaskModePath.replace(/\\/g, '/')))
        );

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('restart-review-cycle refreshes the current diff with a custom task-mode artifact path', { concurrency: false }, async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-903b-restart-review-cycle-custom-task-mode';
        const customTaskModePath = path.join(repoRoot, 'custom-artifacts', `${taskId}-task-mode.json`);
        seedRemediationRepoBase(repoRoot);
        initializeGitRepo(repoRoot);
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');
        writeReviewCapabilitiesConfig(repoRoot);
        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'const a = 2;\nconst b = 3;\nconsole.log(a + b);\n', 'utf8');
        fs.mkdirSync(path.join(repoRoot, 'tests'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'tests', 'app.test.ts'), 'it("works", () => {});\n', 'utf8');
        const { commandsPath, outputFiltersPath } = writeSimpleCompileCommandsFile(repoRoot, 'restart-review-cycle-custom-task-mode');

        runEnterTaskMode({
            repoRoot,
            taskId,
            artifactPath: customTaskModePath,
            taskSummary: 'Restart the review cycle with a custom task-mode artifact path',
            provider: 'Codex',
            plannedChangedFiles: [
                'commands-restart-review-cycle-custom-task-mode.md',
                'garda-agent-orchestrator/live/config/review-capabilities.json',
                'src/app.ts',
                'tests/app.test.ts'
            ]
        });
        loadTaskEntryRulePack(repoRoot, taskId, customTaskModePath);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        const preflightPath = runExplicitPreflight(
            repoRoot,
            taskId,
            'Restart the review cycle with a custom task-mode artifact path',
            ['src/app.ts', 'tests/app.test.ts'],
            `${taskId}-preflight.json`,
            customTaskModePath
        );
        loadPostPreflightRulePack(repoRoot, taskId, preflightPath, true, '', customTaskModePath);

        const compileResult = await runCompileGateCommand({
            repoRoot,
            taskId,
            taskModePath: customTaskModePath,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(compileResult.exitCode, 0);

        const restartResult = await runRestartReviewCycleCommand({
            repoRoot,
            taskId,
            taskModePath: customTaskModePath,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(restartResult.exitCode, 0, restartResult.outputLines.join('\n'));
        assert.match(restartResult.outputLines.join('\n'), /REVIEW_CYCLE_RESTARTED/);
        assert.match(restartResult.outputLines.join('\n'), /PreparedReviewTypes: code/);
        assert.match(restartResult.outputLines.join('\n'), /LaunchRequiredReviewTypes: code/);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

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

    it('runBuildReviewContextCommand reuses supplied task-mode evidence and runtime identity without rereading the artifact', { concurrency: false }, async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-903b-restart-review-cycle-task-mode-cache';
        seedRemediationRepoBase(repoRoot);
        initializeGitRepo(repoRoot);
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');
        writeReviewCapabilitiesConfig(repoRoot);
        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'const a = 2;\nconst b = 3;\nconsole.log(a + b);\n', 'utf8');
        const { commandsPath, outputFiltersPath } = writeSimpleCompileCommandsFile(repoRoot, 'restart-review-cycle-task-mode-cache');
        const taskModeArtifactPath = path.join(
            getOrchestratorRoot(repoRoot),
            'runtime',
            'reviews',
            `${taskId}-task-mode.json`
        );

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Reuse supplied task-mode evidence during build-review-context command execution'
        });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        const preflightPath = runExplicitPreflight(
            repoRoot,
            taskId,
            'Reuse supplied task-mode evidence during build-review-context command execution',
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

        const taskModeEvidence = getTaskModeEvidence(repoRoot, taskId, '');
        const runtimeReviewerIdentity = resolveRuntimeReviewerIdentity({
            repoRoot,
            taskId,
            taskModePath: String(taskModeEvidence.evidence_path || ''),
            taskModeEvidence,
            allowLegacyFallback: true
        });
        fs.rmSync(taskModeArtifactPath, { force: true });

        const buildResult = await runBuildReviewContextCommand({
            repoRoot,
            reviewType: 'code',
            depth: '2',
            preflightPath,
            taskModePath: String(taskModeEvidence.evidence_path || ''),
            taskModeEvidence,
            runtimeReviewerIdentity
        });

        assert.equal(fs.existsSync(taskModeArtifactPath), false);
        assert.ok(buildResult.outputLines.some((line) => line.startsWith('OutputPath: ')));
        assert.equal(buildResult.reusedReviewEvidence, false);
        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('restart-review-cycle escalates to restart-coherent-cycle after a prior review gate closed the latest cycle', { concurrency: false }, async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-903b-restart-review-cycle-after-review-gate';
        seedRemediationRepoBase(repoRoot);
        initializeGitRepo(repoRoot);
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');
        writeReviewCapabilitiesConfig(repoRoot);
        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'const a = 2;\nconst b = 4;\nconsole.log(a + b);\n', 'utf8');
        const { commandsPath, outputFiltersPath } = writeSimpleCompileCommandsFile(repoRoot, 'restart-review-cycle-after-review-gate');

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Restart the review cycle after a prior review gate already closed the last cycle',
            plannedChangedFiles: [
                'commands-restart-review-cycle-after-review-gate.md',
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
            'Restart the review cycle after a prior review gate already closed the last cycle',
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

        const reviewGateResult = runRequiredReviewsCheckCommand({
            repoRoot,
            taskId,
            preflightPath,
            codeReviewVerdict: 'REVIEW PASSED',
            emitMetrics: false
        });
        assert.equal(reviewGateResult.exitCode, 0, reviewGateResult.outputLines.join('\n'));

        const restartResult = await runRestartReviewCycleCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(restartResult.exitCode, EXIT_GATE_FAILURE, restartResult.outputLines.join('\n'));
        assert.match(restartResult.outputLines.join('\n'), /REVIEW_CYCLE_RESTART_FAILED/);
        assert.match(restartResult.outputLines.join('\n'), /REVIEW_GATE_PASSED/);
        assert.match(restartResult.outputLines.join('\n'), /restart-coherent-cycle/);

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
        const reviewGateIndex = findLastTimelineEventIndex(events, (event) => event.event_type === 'REVIEW_GATE_PASSED');
        const lastHandshakeIndex = handshakeIndexes.at(-1) ?? -1;
        const lastShellSmokeIndex = shellSmokeIndexes.at(-1) ?? -1;
        assert.equal(handshakeIndexes.length, 1);
        assert.equal(shellSmokeIndexes.length, 1);
        assert.ok(reviewGateIndex >= 0);
        assert.ok(reviewGateIndex > lastShellSmokeIndex);
        assert.ok(lastShellSmokeIndex > lastHandshakeIndex);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('restart-review-cycle defaults to the current workspace diff instead of silently reusing the old explicit preflight scope', { concurrency: false }, async (t) => {
        const repoRoot = createTempRepo();
        const taskId = 'T-903b-restart-review-cycle-current-diff';
        seedRemediationRepoBase(repoRoot);
        writeReviewCapabilitiesConfig(repoRoot);
        const { commandsPath, outputFiltersPath } = writeSimpleCompileCommandsFile(repoRoot, 'restart-review-cycle-current-diff');
        initializeGitRepo(repoRoot);
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Restart review cycle from the latest workspace diff after a failed review',
            plannedChangedFiles: [
                'src/app.ts',
                'tests/app.test.ts'
            ]
        });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);

        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'const a = 2;\nconst b = 3;\nconsole.log(a + b);\n', 'utf8');

        const preflightPath = runExplicitPreflight(
            repoRoot,
            taskId,
            'Restart review cycle from the latest workspace diff after a failed review',
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

        const missingImpactResult = await runRestartReviewCycleCommandRaw({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(missingImpactResult.exitCode, EXIT_GATE_FAILURE);
        assert.match(missingImpactResult.outputLines.join('\n'), /requires main-agent remediation impact analysis/);
        const blockedImpactArtifact = JSON.parse(fs.readFileSync(
            path.join(getReviewsRoot(repoRoot), `${taskId}-review-remediation-cycle.json`),
            'utf8'
        )) as Record<string, unknown>;
        assert.equal(blockedImpactArtifact.status, 'BLOCKED');
        assert.equal(blockedImpactArtifact.reason, 'missing_or_incomplete_remediation_impact_analysis');
        assert.equal((blockedImpactArtifact.impact_analysis as Record<string, unknown>).status, 'BLOCKED');
        assert.equal(
            (blockedImpactArtifact.remediation_fix_classification as Record<string, unknown>).category,
            'unknown'
        );
        assert.equal(
            (blockedImpactArtifact.remediation_fix_classification as Record<string, unknown>).scope_category,
            'test_only_expansion'
        );
        assert.deepEqual(
            (blockedImpactArtifact.remediation_fix_classification as Record<string, unknown>).invalidated_review_types,
            []
        );

        const boilerplateImpactResult = await runRestartReviewCycleCommandRaw({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            impactAnalysis: [
                'Reviewer finding: reviewer finding.',
                'Intended fix: intended fix.',
                'Affected files/contracts: affected files and contracts.',
                'API/runtime/artifact/test impact: api runtime artifact test impact.',
                'Possible side effects: possible side effects.',
                'Required targeted checks: required targeted checks.',
                'Scope or review impact: scope or review impact.',
                'Related blockers/follow-up: related blocker or follow-up decision.'
            ].join(' '),
            emitMetrics: false
        });
        assert.equal(boilerplateImpactResult.exitCode, EXIT_GATE_FAILURE);
        const boilerplateOutput = boilerplateImpactResult.outputLines.join('\n');
        assert.match(boilerplateOutput, /needs task-specific detail|must mention at least one affected file/);

        const validImpactAnalysis = buildDefaultRemediationImpactAnalysis(
            ['src/app.ts', 'tests/app.test.ts'],
            preflightPath
        );
        const outsideImpactPath = path.join(os.tmpdir(), `${taskId}-outside-impact-analysis.md`);
        fs.writeFileSync(outsideImpactPath, validImpactAnalysis, 'utf8');
        const outsideImpactResult = await runRestartReviewCycleCommandRaw({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            impactAnalysisPath: outsideImpactPath,
            emitMetrics: false
        });
        assert.equal(outsideImpactResult.exitCode, EXIT_GATE_FAILURE);
        assert.match(outsideImpactResult.outputLines.join('\n'), /must stay inside the repository root/);
        fs.rmSync(outsideImpactPath, { force: true });

        const outsideLargeImpactPath = path.join(os.tmpdir(), `${taskId}-outside-large-impact-analysis.md`);
        fs.writeFileSync(outsideLargeImpactPath, `${validImpactAnalysis}\n${'x'.repeat(70 * 1024)}`, 'utf8');
        const outsideLargeImpactResult = await runRestartReviewCycleCommandRaw({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            impactAnalysisPath: outsideLargeImpactPath,
            emitMetrics: false
        });
        assert.equal(outsideLargeImpactResult.exitCode, EXIT_GATE_FAILURE);
        const outsideLargeOutput = outsideLargeImpactResult.outputLines.join('\n');
        assert.match(outsideLargeOutput, /must stay inside the repository root/);
        assert.doesNotMatch(outsideLargeOutput, /must be <= 65536 bytes/);
        fs.rmSync(outsideLargeImpactPath, { force: true });

        const outsideSymlinkTarget = path.join(os.tmpdir(), `${taskId}-outside-symlink-impact-analysis.md`);
        const symlinkImpactPath = path.join(repoRoot, 'symlink-impact-analysis.md');
        await t.test('restart-review-cycle rejects repo-local symlinked impact analysis paths outside repo', async (symlinkTest) => {
            try {
                fs.writeFileSync(outsideSymlinkTarget, validImpactAnalysis, 'utf8');
                fs.symlinkSync(outsideSymlinkTarget, symlinkImpactPath, 'file');
                const symlinkImpactResult = await runRestartReviewCycleCommandRaw({
                    repoRoot,
                    taskId,
                    preflightPath,
                    commandsPath,
                    outputFiltersPath,
                    impactAnalysisPath: 'symlink-impact-analysis.md',
                    emitMetrics: false
                });
                assert.equal(symlinkImpactResult.exitCode, EXIT_GATE_FAILURE);
                assert.match(symlinkImpactResult.outputLines.join('\n'), /must stay inside the repository root/);
            } catch (error: unknown) {
                const code = (error as { code?: string }).code;
                if (code !== 'EPERM' && code !== 'EACCES') {
                    throw error;
                }
                symlinkTest.skip('file symlink creation is not permitted in this environment');
            } finally {
                fs.rmSync(symlinkImpactPath, { force: true });
                fs.rmSync(outsideSymlinkTarget, { force: true });
            }
        });

        const largeImpactPath = path.join(repoRoot, 'large-impact-analysis.md');
        fs.writeFileSync(largeImpactPath, `${validImpactAnalysis}\n${'x'.repeat(70 * 1024)}`, 'utf8');
        const largeImpactResult = await runRestartReviewCycleCommandRaw({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            impactAnalysisPath: 'large-impact-analysis.md',
            emitMetrics: false
        });
        assert.equal(largeImpactResult.exitCode, EXIT_GATE_FAILURE);
        assert.match(largeImpactResult.outputLines.join('\n'), /must be <= 65536 bytes/);
        fs.rmSync(largeImpactPath, { force: true });

        const restartResult = await runRestartReviewCycleCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(restartResult.exitCode, 0, restartResult.outputLines.join('\n'));

        const output = restartResult.outputLines.join('\n');
        assert.match(output, /DetectionSource: git_auto_current_workspace/);
        assert.match(output, /ReviewRemediationCycleArtifact:/);
        assert.match(output, /RemediationFixClassification: test_coverage_only; invalidated_review_types=test; preserved_review_types=code/);
        assert.match(output, /ScopeBoundary: OK; previous=1; current=2; expanded_non_test=none/);
        assert.match(output, /RefreshPoints: preflight=refreshed; post_preflight_rule_pack=reloaded; compile=rerun/);
        assert.match(output, /ReuseBoundaries: non_test_changes_must_stay_within_previous_preflight_scope/);
        assert.match(output, /PendingReviewTypes: test/);

        const refreshedPreflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
        assert.deepEqual(refreshedPreflight.changed_files, ['src/app.ts', 'tests/app.test.ts']);
        assert.equal((refreshedPreflight.required_reviews as Record<string, boolean>).test, true);
        const remediationArtifact = JSON.parse(fs.readFileSync(
            path.join(getReviewsRoot(repoRoot), `${taskId}-review-remediation-cycle.json`),
            'utf8'
        )) as Record<string, unknown>;
        assert.equal(remediationArtifact.status, 'PASSED');
        assert.equal((remediationArtifact.impact_analysis as Record<string, unknown>).status, 'RECORDED');
        assert.equal((remediationArtifact.impact_analysis as Record<string, unknown>).source, 'inline');
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
        assert.deepEqual(
            (remediationArtifact.remediation_fix_classification as Record<string, unknown>).preserved_review_types,
            ['code']
        );
        assert.deepEqual(
            (remediationArtifact.remediation_scope as Record<string, unknown>).allowed_test_only_expansion_files,
            ['tests/app.test.ts']
        );
        assert.deepEqual(
            (remediationArtifact.remediation_scope as Record<string, unknown>).expanded_non_test_files,
            []
        );

        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'const a = 3;\nconst b = 4;\nconsole.log(a + b);\n', 'utf8');
        const fileImpactAnalysisPath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'impact-analysis.md');
        fs.writeFileSync(fileImpactAnalysisPath, validImpactAnalysis, 'utf8');
        const fileImpactRestartResult = await runRestartReviewCycleCommandRaw({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            impactAnalysisPath: 'garda-agent-orchestrator/runtime/impact-analysis.md',
            emitMetrics: false
        });
        assert.equal(fileImpactRestartResult.exitCode, 0, fileImpactRestartResult.outputLines.join('\n'));
        const fileImpactArtifact = JSON.parse(fs.readFileSync(
            path.join(getReviewsRoot(repoRoot), `${taskId}-review-remediation-cycle.json`),
            'utf8'
        )) as Record<string, unknown>;
        assert.equal(fileImpactArtifact.status, 'PASSED');
        assert.equal((fileImpactArtifact.impact_analysis as Record<string, unknown>).status, 'RECORDED');
        assert.equal((fileImpactArtifact.impact_analysis as Record<string, unknown>).source, 'file');

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

    it('restart-review-cycle refuses to rebuild from a fresh task-mode cycle that never restored TASK_ENTRY rule-pack evidence', { concurrency: false }, async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-903b-restart-review-cycle-missing-task-entry';
        seedRemediationRepoBase(repoRoot);
        initializeGitRepo(repoRoot);
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');
        writeReviewCapabilitiesConfig(repoRoot);
        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'const a = 2;\nconst b = 5;\nconsole.log(a + b);\n', 'utf8');
        const { commandsPath, outputFiltersPath } = writeSimpleCompileCommandsFile(repoRoot, 'restart-review-cycle-missing-task-entry');

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Reject review-cycle restart when the latest task-mode cycle never restored task-entry rule-pack evidence',
            plannedChangedFiles: [
                'commands-restart-review-cycle-missing-task-entry.md',
                'garda-agent-orchestrator/live/config/review-capabilities.json',
                'src/app.ts'
            ]
        });

        const preflightPath = writePreflight(repoRoot, taskId, {
            metrics: { changed_lines_total: 3, changed_files_count: 1 },
            changed_files: ['src/app.ts'],
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

        const restartResult = await runRestartReviewCycleCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(restartResult.exitCode, EXIT_GATE_FAILURE, restartResult.outputLines.join('\n'));
        const output = restartResult.outputLines.join('\n');
        assert.match(output, /REVIEW_CYCLE_RESTART_FAILED/);
        assert.match(output, /TASK_MODE_ENTERED without matching RULE_PACK_LOADED for TASK_ENTRY/);
        assert.match(output, /restart-coherent-cycle/);

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
        assert.equal(handshakeIndexes.length, 0);
        assert.equal(shellSmokeIndexes.length, 0);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('runBuildReviewContextCommand preserves the public key-value output contract', { concurrency: false }, async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-903b-build-review-context-output-contract';
        seedRemediationRepoBase(repoRoot);
        initializeGitRepo(repoRoot);
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');
        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'const a = 2;\nconst b = 3;\nconsole.log(a + b);\n', 'utf8');

        const { commandsPath, outputFiltersPath } = writeSimpleCompileCommandsFile(repoRoot, 'build-review-context-output-contract');

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Preserve build-review-context output formatting contract'
        });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        const preflightPath = runExplicitPreflight(
            repoRoot,
            taskId,
            'Preserve build-review-context output formatting contract',
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

        const expectedReviewContextPath = path.join(getReviewsRoot(repoRoot), `${taskId}-code-review-context.json`);
        fs.mkdirSync(path.dirname(expectedReviewContextPath), { recursive: true });
        fs.writeFileSync(expectedReviewContextPath, '{"stale":true}\n', 'utf8');

        const buildResult = await runBuildReviewContextCommand({
            repoRoot,
            reviewType: 'code',
            depth: '2',
            preflightPath
        });
        const expectedReviewContextSha256 = fileSha256(expectedReviewContextPath);
        const expectedReviewContextDisplayPath = normalizePath(expectedReviewContextPath);
        assert.equal(fs.existsSync(expectedReviewContextPath), true);
        assert.equal(buildResult.outputLines.includes(`ReviewContextPath: ${expectedReviewContextDisplayPath}`), true);
        assert.equal(buildResult.outputLines.includes(`ReviewContextSha256: ${expectedReviewContextSha256}`), true);
        assert.equal(buildResult.outputLines.includes(`OutputPath: ${expectedReviewContextDisplayPath}`), true);
        assert.ok(buildResult.outputLines.some((line) => /^TokenEconomyActive: (True|False)$/.test(line)));
        const reviewContext = JSON.parse(fs.readFileSync(expectedReviewContextPath, 'utf8')) as Record<string, unknown>;
        assert.equal(reviewContext.stale, undefined);
        assert.equal(reviewContext.task_id, taskId);
        assert.equal(reviewContext.review_type, 'code');

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('runBuildReviewContextCommand fails closed when required review telemetry cannot be appended', { concurrency: false }, async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-903b-build-review-context-telemetry-lock';
        seedRemediationRepoBase(repoRoot);
        initializeGitRepo(repoRoot);
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');
        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'const a = 2;\nconst b = 3;\nconsole.log(a + b);\n', 'utf8');

        const { commandsPath, outputFiltersPath } = writeSimpleCompileCommandsFile(repoRoot, 'build-review-context-telemetry-lock');

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Fail closed when review-context telemetry cannot be appended'
        });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        const preflightPath = runExplicitPreflight(
            repoRoot,
            taskId,
            'Fail closed when review-context telemetry cannot be appended',
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

        const taskEventLockPath = path.join(getOrchestratorRoot(repoRoot), 'runtime', 'task-events', `.${taskId}.lock`);
        fs.mkdirSync(path.dirname(taskEventLockPath), { recursive: true });
        await withFilesystemLockAsync(taskEventLockPath, { timeoutMs: 30000, retryMs: 1 }, async () => {
            await assert.rejects(
                () => runBuildReviewContextCommand({
                    repoRoot,
                    reviewType: 'code',
                    depth: '2',
                    preflightPath,
                    telemetryLockTimeoutMs: 20,
                    telemetryLockRetryMs: 1
                }),
                /Mandatory lifecycle event 'REVIEW_PHASE_STARTED' append failed/
            );
        });

        const timelineEvents = readTaskTimelineEvents(repoRoot, taskId);
        assert.equal(
            timelineEvents.some((event) => event.event_type === 'REVIEW_PHASE_STARTED'),
            false
        );

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('runBuildReviewContextCommand reuses the supplied timeline summary for code-review reuse without rereading task events', { concurrency: false }, async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-903b-build-review-context-reuse-timeline-cache';
        seedRemediationRepoBase(repoRoot);
        initializeGitRepo(repoRoot);
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');
        writeReviewCapabilitiesConfig(repoRoot);
        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'const a = 2;\nconst b = 3;\nconsole.log(a + b);\n', 'utf8');

        const { commandsPath, outputFiltersPath } = writeSimpleCompileCommandsFile(repoRoot, 'build-review-context-reuse-timeline-cache');

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Reuse supplied timeline summary when recycling current-cycle code review evidence'
        });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        const preflightPath = runExplicitPreflight(
            repoRoot,
            taskId,
            'Reuse supplied timeline summary when recycling current-cycle code review evidence',
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

        const reviewContextPath = path.join(getReviewsRoot(repoRoot), `${taskId}-code-review-context.json`);
        seedReusableReviewEvidence(
            repoRoot,
            taskId,
            'code',
            'REVIEW PASSED',
            preflightPath,
            reviewContextPath
        );
        const refreshedCompileResult = await runCompileGateCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(refreshedCompileResult.exitCode, 0);
        const timelinePath = path.join(getOrchestratorRoot(repoRoot), 'runtime', 'task-events', `${taskId}.jsonl`);
        const timelineSummary = readTimelineEventsSummary(timelinePath);
        fs.rmSync(timelinePath, { force: true });

        const buildResult = await runBuildReviewContextCommand({
            repoRoot,
            reviewType: 'code',
            depth: '2',
            preflightPath,
            timelineEventsSummary: timelineSummary
        });

        assert.equal(buildResult.reusedReviewEvidence, true);
        assert.ok(buildResult.reusedReceiptPath);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('required-reviews-check rejects optional skill loads when policy mode is off', () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-149-review-off-mode';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');
        fs.mkdirSync(path.join(repoRoot, 'src', 'api'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'src', 'api', 'orders.ts'), 'export const order = 1;\n', 'utf8');
        const optionalSkillPath = seedNodeBackendOptionalSkillFixture(repoRoot, 'off');

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Reject optional skill loads at review gate when policy mode is off'
        });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);

        const preflightPath = writePreflight(repoRoot, taskId, {
            metrics: { changed_lines_total: 3 },
            changed_files: ['src/api/orders.ts'],
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
        const crypto = require('node:crypto');
        const preflightSha256 = crypto.createHash('sha256').update(fs.readFileSync(preflightPath, 'utf8')).digest('hex');
        writeOptionalSkillSelectionArtifact(getOrchestratorRoot(repoRoot), taskId, {
            taskText: 'Implement request validation for a Node.js API endpoint.',
            changedPaths: ['src/api/orders.ts'],
            preflightPath,
            preflightSha256
        });
        loadPostPreflightRulePack(repoRoot, taskId, preflightPath);
        writeCompilePassEvidence(repoRoot, taskId, preflightPath);

        const reviewContextPath = path.join(getReviewsRoot(repoRoot), `${taskId}-code-review-context.json`);
        seedReusableReviewEvidence(
            repoRoot,
            taskId,
            'code',
            'REVIEW PASSED',
            preflightPath,
            reviewContextPath,
            'agent:code-reviewer'
        );
        appendTaskEvent(
            getOrchestratorRoot(repoRoot),
            taskId,
            'SKILL_REFERENCE_LOADED',
            'INFO',
            'Optional skill loaded after an off-mode selection.',
            {
                skill_id: 'node-backend',
                reference_path: optionalSkillPath,
                trigger_reason: 'manual'
            }
        );

        const reviewGateResult = runRequiredReviewsCheckCommand({
            repoRoot,
            taskId,
            preflightPath,
            codeReviewVerdict: 'REVIEW PASSED',
            emitMetrics: false
        });

        assert.equal(reviewGateResult.exitCode, EXIT_GATE_FAILURE);
        assert.equal(reviewGateResult.outputLines[0], 'REVIEW_GATE_FAILED');
        assert.ok(reviewGateResult.outputLines.some((line) => line.includes("policy mode is 'off'")));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('required-reviews-check rejects stale strict optional-skill artifacts when the current TASK.md title changes', () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-149-review-stale-task-text';
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
        seedInitAnswers(repoRoot, 'Codex');
        fs.mkdirSync(path.join(repoRoot, 'docs'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'docs', 'landing.md'), 'hello\n', 'utf8');
        seedNodeBackendOptionalSkillFixture(repoRoot, 'strict');

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Implement request validation for a Node.js API endpoint'
        });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);

        const preflightPath = writePreflight(repoRoot, taskId, {
            metrics: { changed_lines_total: 3 },
            changed_files: ['docs/landing.md'],
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
        const crypto = require('node:crypto');
        const preflightSha256 = crypto.createHash('sha256').update(fs.readFileSync(preflightPath, 'utf8')).digest('hex');
        writeOptionalSkillSelectionArtifact(getOrchestratorRoot(repoRoot), taskId, {
            taskText: 'Implement request validation for a Node.js API endpoint',
            changedPaths: ['docs/landing.md'],
            preflightPath,
            preflightSha256
        });
        fs.writeFileSync(
            taskPath,
            fs.readFileSync(taskPath, 'utf8').replace(
                'Implement request validation for a Node.js API endpoint',
                'Refresh landing-page copy for the marketing site'
            ),
            'utf8'
        );
        loadPostPreflightRulePack(repoRoot, taskId, preflightPath);
        writeCompilePassEvidence(repoRoot, taskId, preflightPath);

        const reviewContextPath = path.join(getReviewsRoot(repoRoot), `${taskId}-code-review-context.json`);
        seedReusableReviewEvidence(
            repoRoot,
            taskId,
            'code',
            'REVIEW PASSED',
            preflightPath,
            reviewContextPath,
            'agent:code-reviewer'
        );

        const reviewGateResult = runRequiredReviewsCheckCommand({
            repoRoot,
            taskId,
            preflightPath,
            codeReviewVerdict: 'REVIEW PASSED',
            emitMetrics: false
        });

        assert.equal(reviewGateResult.exitCode, EXIT_GATE_FAILURE);
        assert.equal(reviewGateResult.outputLines[0], 'REVIEW_GATE_FAILED');
        assert.ok(reviewGateResult.outputLines.some((line) => line.includes('current task summary hash')));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('required-reviews-check rejects strict optional-skill artifacts when the task row disappears from TASK.md', () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-149-review-missing-task-row';
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
        seedInitAnswers(repoRoot, 'Codex');
        fs.mkdirSync(path.join(repoRoot, 'docs'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'docs', 'landing.md'), 'hello\n', 'utf8');
        seedNodeBackendOptionalSkillFixture(repoRoot, 'strict');

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Implement request validation for a Node.js API endpoint'
        });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);

        const preflightPath = writePreflight(repoRoot, taskId, {
            metrics: { changed_lines_total: 3 },
            changed_files: ['docs/landing.md'],
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
        const crypto = require('node:crypto');
        const preflightSha256 = crypto.createHash('sha256').update(fs.readFileSync(preflightPath, 'utf8')).digest('hex');
        writeOptionalSkillSelectionArtifact(getOrchestratorRoot(repoRoot), taskId, {
            taskText: 'Implement request validation for a Node.js API endpoint',
            changedPaths: ['docs/landing.md'],
            preflightPath,
            preflightSha256
        });
        fs.writeFileSync(
            taskPath,
            [
                '| ID | Status | Priority | Area | Title | Assignee | Updated | Profile | Notes |',
                '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
                '| T-999 | TODO | P2 | docs | Placeholder task | unassigned | 2026-03-28 | default | fixture |'
            ].join('\n'),
            'utf8'
        );
        loadPostPreflightRulePack(repoRoot, taskId, preflightPath);
        writeCompilePassEvidence(repoRoot, taskId, preflightPath);

        const reviewContextPath = path.join(getReviewsRoot(repoRoot), `${taskId}-code-review-context.json`);
        seedReusableReviewEvidence(
            repoRoot,
            taskId,
            'code',
            'REVIEW PASSED',
            preflightPath,
            reviewContextPath,
            'agent:code-reviewer'
        );

        const reviewGateResult = runRequiredReviewsCheckCommand({
            repoRoot,
            taskId,
            preflightPath,
            codeReviewVerdict: 'REVIEW PASSED',
            emitMetrics: false
        });

        assert.equal(reviewGateResult.exitCode, EXIT_GATE_FAILURE);
        assert.equal(reviewGateResult.outputLines[0], 'REVIEW_GATE_FAILED');
        assert.ok(reviewGateResult.outputLines.some((line) => line.includes('current task summary hash')));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('completion diagnostics surface restart-review-cycle when review evidence is incomplete without a stage-sequence failure', { concurrency: false }, async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-903b-review-recovery-command';
        seedRemediationRepoBase(repoRoot);
        initializeGitRepo(repoRoot);
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');
        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'const a = 2;\nconst b = 3;\nconsole.log(a + b);\n', 'utf8');

        const { commandsPath, outputFiltersPath } = writeSimpleCompileCommandsFile(repoRoot, 'review-recovery-command');

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Surface a narrow review-cycle recovery command from completion diagnostics'
        });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        const preflightPath = runExplicitPreflight(
            repoRoot,
            taskId,
            'Surface a narrow review-cycle recovery command from completion diagnostics',
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

        const buildResult = await runBuildReviewContextCommand({
            repoRoot,
            reviewType: 'code',
            depth: '2',
            preflightPath
        });
        assert.ok(buildResult.outputLines.some((line) => line.startsWith('OutputPath: ')));

        const completionResult = runCompletionGate({
            repoRoot,
            preflightPath,
            taskId
        });
        assert.equal(completionResult.outcome, 'FAIL');
        assert.equal(completionResult.stage_sequence_evidence.violations.length, 0);
        assert.match(
            String((completionResult as Record<string, unknown>).review_cycle_restart_command || ''),
            /restart-review-cycle/
        );
        assert.match(
            formatCompletionGateResult(completionResult as Record<string, unknown>),
            /RecoveryCommand: .*restart-review-cycle/
        );

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('restart-review-cycle remains usable after COMPLETION_GATE_FAILED when completion diagnostics advertise that narrow recovery path', { concurrency: false }, async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-903b-review-recovery-command-after-completion-fail';
        seedRemediationRepoBase(repoRoot);
        initializeGitRepo(repoRoot);
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');
        writeReviewCapabilitiesConfig(repoRoot);
        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'const a = 2;\nconst b = 3;\nconsole.log(a + b);\n', 'utf8');
        fs.mkdirSync(path.join(repoRoot, 'tests'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'tests', 'app.test.ts'), 'it(\"works\", () => {});\n', 'utf8');

        const { commandsPath, outputFiltersPath } = writeSimpleCompileCommandsFile(repoRoot, 'review-recovery-command-after-completion-fail');

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Keep restart-review-cycle usable after completion diagnostics surface it as the recovery command'
        });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        const preflightPath = runExplicitPreflight(
            repoRoot,
            taskId,
            'Keep restart-review-cycle usable after completion diagnostics surface it as the recovery command',
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

        const buildResult = await runBuildReviewContextCommand({
            repoRoot,
            reviewType: 'code',
            depth: '2',
            preflightPath
        });
        assert.ok(buildResult.outputLines.some((line) => line.startsWith('OutputPath: ')));

        const completionResult = runCompletionGate({
            repoRoot,
            preflightPath,
            taskId
        });
        assert.equal(completionResult.outcome, 'FAIL');
        assert.equal(completionResult.stage_sequence_evidence.violations.length, 0);
        assert.match(
            String((completionResult as Record<string, unknown>).review_cycle_restart_command || ''),
            /restart-review-cycle/
        );

        const restartResult = await runRestartReviewCycleCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(restartResult.exitCode, 0, restartResult.outputLines.join('\n'));
        assert.match(restartResult.outputLines.join('\n'), /REVIEW_CYCLE_RESTARTED/);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('restart-review-cycle fails after a fresh TASK_MODE_ENTERED when TASK_ENTRY was not restored for that new cycle', { concurrency: false }, async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-903b-review-recovery-missing-task-entry';
        seedRemediationRepoBase(repoRoot);
        initializeGitRepo(repoRoot);
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');
        writeReviewCapabilitiesConfig(repoRoot);
        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'const a = 2;\nconst b = 3;\nconsole.log(a + b);\n', 'utf8');
        fs.mkdirSync(path.join(repoRoot, 'tests'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'tests', 'app.test.ts'), 'it("works", () => {});\n', 'utf8');

        const { commandsPath, outputFiltersPath } = writeSimpleCompileCommandsFile(repoRoot, 'review-recovery-missing-task-entry');

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Reject restart-review-cycle when a fresh task-mode cycle did not reload task-entry rules'
        });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        const preflightPath = runExplicitPreflight(
            repoRoot,
            taskId,
            'Reject restart-review-cycle when a fresh task-mode cycle did not reload task-entry rules',
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

        const buildResult = await runBuildReviewContextCommand({
            repoRoot,
            reviewType: 'code',
            depth: '2',
            preflightPath
        });
        assert.ok(buildResult.outputLines.some((line) => line.startsWith('OutputPath: ')));

        const completionResult = runCompletionGate({
            repoRoot,
            preflightPath,
            taskId
        });
        assert.equal(completionResult.outcome, 'FAIL');
        assert.equal(completionResult.stage_sequence_evidence.violations.length, 0);

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Fresh task-mode cycle without task-entry reload must not use restart-review-cycle'
        });

        const restartResult = await runRestartReviewCycleCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(restartResult.exitCode, EXIT_GATE_FAILURE, restartResult.outputLines.join('\n'));
        assert.match(
            restartResult.outputLines.join('\n'),
            /TASK_MODE_ENTERED without matching RULE_PACK_LOADED for TASK_ENTRY/
        );
        assert.match(restartResult.outputLines.join('\n'), /Run restart-coherent-cycle/);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('restart-review-cycle remains usable after a fresh TASK_MODE_ENTERED when TASK_ENTRY is restored for that new cycle', { concurrency: false }, async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-903b-review-recovery-restored-task-entry';
        seedRemediationRepoBase(repoRoot);
        initializeGitRepo(repoRoot);
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');
        writeReviewCapabilitiesConfig(repoRoot);
        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'const a = 2;\nconst b = 3;\nconsole.log(a + b);\n', 'utf8');
        fs.mkdirSync(path.join(repoRoot, 'tests'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'tests', 'app.test.ts'), 'it("works", () => {});\n', 'utf8');

        const { commandsPath, outputFiltersPath } = writeSimpleCompileCommandsFile(repoRoot, 'review-recovery-restored-task-entry');

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Keep restart-review-cycle usable when a fresh task-mode cycle reloads task-entry rules'
        });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        const preflightPath = runExplicitPreflight(
            repoRoot,
            taskId,
            'Keep restart-review-cycle usable when a fresh task-mode cycle reloads task-entry rules',
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

        const buildResult = await runBuildReviewContextCommand({
            repoRoot,
            reviewType: 'code',
            depth: '2',
            preflightPath
        });
        assert.ok(buildResult.outputLines.some((line) => line.startsWith('OutputPath: ')));

        const completionResult = runCompletionGate({
            repoRoot,
            preflightPath,
            taskId
        });
        assert.equal(completionResult.outcome, 'FAIL');
        assert.equal(completionResult.stage_sequence_evidence.violations.length, 0);

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Fresh task-mode cycle with task-entry reload should keep restart-review-cycle available'
        });
        loadTaskEntryRulePack(repoRoot, taskId);

        const restartResult = await runRestartReviewCycleCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(restartResult.exitCode, 0, restartResult.outputLines.join('\n'));
        assert.match(restartResult.outputLines.join('\n'), /REVIEW_CYCLE_RESTARTED/);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });
});

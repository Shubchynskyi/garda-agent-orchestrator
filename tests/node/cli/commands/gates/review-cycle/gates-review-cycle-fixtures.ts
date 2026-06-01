import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { EXIT_GATE_FAILURE } from '../../../../../../src/cli/exit-codes';
import { readTimelineEventsSummary, runBuildReviewContextCommand } from '../../../../../../src/cli/commands/gate-build-handlers';
import {
    runCompileGateCommand,
    runRecordReviewCycleSplitDecisionCommand,
    runRestartCoherentCycleCommand,
    runRestartReviewCycleCommand as runRestartReviewCycleCommandRaw,
    runRequiredReviewsCheckCommand
} from '../../../../../../src/cli/commands/gates';
import { formatCompletionGateResult, runCompletionGate } from '../../../../../../src/gates/completion';
import { fileSha256, normalizePath, writeProtectedControlPlaneManifest } from '../../../../../../src/gates/shared/helpers';
import { serializeTaskPlan, validateTaskPlan } from '../../../../../../src/schemas/task-plan';
import { buildReviewContext } from '../../../../../../src/gates/review-context/build-review-context';
import { buildScopedDiff } from '../../../../../../src/gates/preflight/build-scoped-diff';
import { buildReviewContextPreflightDiffExpectations } from '../../../../../../src/gates/review-context/review-context-contract';
import { buildReviewTreeState } from '../../../../../../src/gates/review/review-tree-state';
import {
    computeReviewRelevantScopeFingerprint,
    isNonTestReviewScope
} from '../../../../../../src/gates/review-reuse';
import { resolveRuntimeReviewerIdentity } from '../../../../../../src/gates/review/reviewer-routing';
import { getTaskModeEvidence } from '../../../../../../src/gates/task-mode';
import { getCurrentWorkflowConfigFileHashes } from '../../../../../../src/gates/workflow-config/workflow-config-work';
import { appendTaskEvent } from '../../../../../../src/gate-runtime/task-events';
import { withFilesystemLockAsync } from '../../../../../../src/gate-runtime/task-events-locking';
import { ensureSkillsHeadlinesCurrent } from '../../../../../../src/runtime/skill-headlines';
import { writeOptionalSkillSelectionArtifact } from '../../../../../../src/runtime/optional-skill-selection';
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
} from '../../gate-test-helpers';

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

export {
    describe,
    it,
    assert,
    fs,
    os,
    path,
    EXIT_GATE_FAILURE,
    readTimelineEventsSummary,
    runBuildReviewContextCommand,
    runCompileGateCommand,
    runRecordReviewCycleSplitDecisionCommand,
    runRestartCoherentCycleCommand,
    runRequiredReviewsCheckCommand,
    formatCompletionGateResult,
    runCompletionGate,
    fileSha256,
    normalizePath,
    writeProtectedControlPlaneManifest,
    serializeTaskPlan,
    validateTaskPlan,
    buildReviewContext,
    buildScopedDiff,
    buildReviewContextPreflightDiffExpectations,
    buildReviewTreeState,
    computeReviewRelevantScopeFingerprint,
    isNonTestReviewScope,
    resolveRuntimeReviewerIdentity,
    getTaskModeEvidence,
    getCurrentWorkflowConfigFileHashes,
    appendTaskEvent,
    withFilesystemLockAsync,
    ensureSkillsHeadlinesCurrent,
    writeOptionalSkillSelectionArtifact,
    createBaseTempRepo,
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
    findLastTimelineEventIndex,
    escapeRegExp,
    markAsSourceCheckout,
    readPreflightChangedFiles,
    buildDefaultRemediationImpactAnalysis,
    runRestartReviewCycleCommand,
    runRestartReviewCycleCommandRaw,
    createTempRepo,
    writeProfilesConfig,
    prepareScopedDiffFixture,
    writeWorkflowConfig,
    seedNodeBackendOptionalSkillFixture,
    seedTaskQueue,
    seedInitAnswers,
    seedRemediationRepoBase,
    writeSimpleCompileCommandsFile
};

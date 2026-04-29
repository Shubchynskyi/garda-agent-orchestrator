import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import { getSetupAnswerDefaults } from '../../../src/cli/commands/setup';
import { runAgentInit } from '../../../src/lifecycle/agent-init';
import { getStatusSnapshot } from '../../../src/validators/status';
import { resolveInitAnswersRelativePath } from '../../../src/core/constants';

const INIT_ANSWERS_RELATIVE_PATH = resolveInitAnswersRelativePath();

const MANAGED_START = '<!-- garda-agent-orchestrator:managed-start -->';
const MANAGED_END = '<!-- garda-agent-orchestrator:managed-end -->';

function writeJson(filePath: string, value: unknown) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
}

function writeText(filePath: string, value: string) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, value, 'utf8');
}

function readWorkflowConfig(bundleRoot: string): Record<string, unknown> {
    return JSON.parse(
        fs.readFileSync(path.join(bundleRoot, 'live', 'config', 'workflow-config.json'), 'utf8')
    ) as Record<string, unknown>;
}

function makeCompliantEntrypoint(name: string): string {
    return [
        MANAGED_START,
        `# ${name}`,
        'This file is a redirect.',
        'Hard stop: open `.agents/workflows/start-task.md`.',
        MANAGED_END
    ].join('\n');
}

test('runAgentInit writes finalized init answers and agent-init state', () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-agent-init-'));
    const bundleRoot = path.join(workspaceRoot, 'garda-agent-orchestrator');
    const initAnswersPath = path.join(bundleRoot, 'runtime', 'init-answers.json');

    try {
        writeJson(initAnswersPath, {
            AssistantLanguage: 'English',
            AssistantBrevity: 'concise',
            SourceOfTruth: 'Codex',
            EnforceNoAutoCommit: 'false',
            ClaudeOrchestratorFullAccess: 'false',
            TokenEconomyEnabled: 'true',
            CollectedVia: 'CLI_INTERACTIVE',
            ActiveAgentFiles: 'AGENTS.md'
        });
        fs.writeFileSync(path.join(bundleRoot, 'VERSION'), '9.9.9-test\n', 'utf8');
        fs.writeFileSync(path.join(bundleRoot, 'MANIFEST.md'), '# Manifest\n', 'utf8');

        const result = runAgentInit({
            targetRoot: workspaceRoot,
            activeAgentFiles: 'AGENTS.md, CLAUDE.md',
            projectRulesUpdated: 'yes',
            skillsPrompted: 'yes',
            installRunner: function () {},
            verifyRunner: function () {
                return { passed: true };
            },
            manifestRunner: function () {
                return { passed: true };
            }
        });

        assert.equal(result.readyForTasks, true);
        assert.deepEqual(result.activeAgentFiles, ['CLAUDE.md', 'AGENTS.md']);

        const persistedAnswers = JSON.parse(fs.readFileSync(initAnswersPath, 'utf8'));
        assert.equal(persistedAnswers.CollectedVia, 'AGENT_INIT_PROMPT.md');
        assert.equal(persistedAnswers.ActiveAgentFiles, 'CLAUDE.md, AGENTS.md');

        const persistedState = JSON.parse(fs.readFileSync(result.agentInitStatePath, 'utf8'));
        assert.equal(persistedState.OrchestratorVersion, '9.9.9-test');
        assert.equal(persistedState.SourceOfTruth, 'Codex');
        assert.equal(persistedState.AssistantLanguageConfirmed, true);
        assert.equal(persistedState.ActiveAgentFilesConfirmed, true);
        assert.equal(persistedState.ProjectRulesUpdated, true);
        assert.equal(persistedState.SkillsPromptCompleted, true);
        assert.equal(persistedState.VerificationPassed, true);
        assert.equal(persistedState.ManifestValidationPassed, true);
        assert.deepEqual(persistedState.ActiveAgentFiles, ['CLAUDE.md', 'AGENTS.md']);
    } finally {
        fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
});

test('setup/status/agent-init handoff keeps ActiveAgentFiles as a single pending checkpoint until one explicit confirmation clears it', () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-agent-init-handoff-'));
    const bundleRoot = path.join(workspaceRoot, 'garda-agent-orchestrator');
    const runtimeRoot = path.join(bundleRoot, 'runtime');
    const defaults = getSetupAnswerDefaults(workspaceRoot, INIT_ANSWERS_RELATIVE_PATH, {
        sourceOfTruth: 'Codex'
    });

    try {
        assert.equal(defaults.activeAgentFiles, 'AGENTS.md');

        writeJson(path.join(runtimeRoot, 'init-answers.json'), {
            AssistantLanguage: defaults.assistantLanguage,
            AssistantBrevity: defaults.assistantBrevity,
            SourceOfTruth: defaults.sourceOfTruth,
            EnforceNoAutoCommit: String(defaults.enforceNoAutoCommit),
            ClaudeOrchestratorFullAccess: String(defaults.claudeOrchestratorFullAccess),
            TokenEconomyEnabled: String(defaults.tokenEconomyEnabled),
            CollectedVia: 'CLI_NONINTERACTIVE',
            ActiveAgentFiles: defaults.activeAgentFiles
        });
        writeJson(path.join(runtimeRoot, 'agent-init-state.json'), {
            Version: 1,
            UpdatedAt: new Date().toISOString(),
            OrchestratorVersion: '9.9.9-test',
            AssistantLanguage: 'English',
            SourceOfTruth: 'Codex',
            AssistantLanguageConfirmed: true,
            ActiveAgentFilesConfirmed: false,
            ProjectRulesUpdated: false,
            SkillsPromptCompleted: false,
            VerificationPassed: false,
            ManifestValidationPassed: false,
            ActiveAgentFiles: ['AGENTS.md']
        });

        writeText(path.join(bundleRoot, 'VERSION'), '9.9.9-test\n');
        writeText(path.join(bundleRoot, 'MANIFEST.md'), '# Manifest\n');
        writeText(path.join(bundleRoot, 'package.json'), JSON.stringify({ name: 'garda-agent-orchestrator' }, null, 2));
        writeText(path.join(bundleRoot, 'live', 'USAGE.md'), '# Usage\n');
        writeText(path.join(bundleRoot, 'live', 'docs', 'agent-rules', '40-commands.md'), 'npm install\nnpm test\nnpm run lint\n');
        writeText(path.join(workspaceRoot, 'TASK.md'), '# Tasks\n');
        writeText(path.join(workspaceRoot, '.agents', 'workflows', 'start-task.md'), [MANAGED_START, '# Start Task', 'Shared router.', MANAGED_END].join('\n'));
        writeText(path.join(workspaceRoot, 'AGENTS.md'), makeCompliantEntrypoint('AGENTS.md'));
        writeText(path.join(workspaceRoot, 'CLAUDE.md'), makeCompliantEntrypoint('CLAUDE.md'));

        const pendingSnapshot = getStatusSnapshot(workspaceRoot);
        assert.equal(pendingSnapshot.agentInitializationPendingReason, 'ACTIVE_AGENT_FILES_PENDING');
        assert.equal(pendingSnapshot.activeAgentFiles, 'AGENTS.md');

        const result = runAgentInit({
            targetRoot: workspaceRoot,
            activeAgentFiles: 'AGENTS.md, CLAUDE.md',
            projectRulesUpdated: 'yes',
            skillsPrompted: 'yes',
            installRunner: function () {},
            verifyRunner: function () {
                return { passed: true };
            },
            manifestRunner: function () {
                return { passed: true };
            }
        });

        assert.equal(result.readyForTasks, true);

        const readySnapshot = getStatusSnapshot(workspaceRoot);
        assert.equal(readySnapshot.agentInitializationPendingReason, null);
        assert.equal(readySnapshot.readyForTasks, true);
        assert.equal(readySnapshot.activeAgentFiles, 'CLAUDE.md, AGENTS.md');
    } finally {
        fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
});

test('runAgentInit keeps workspace not-ready when required checkpoints are marked as incomplete', () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-agent-init-'));
    const bundleRoot = path.join(workspaceRoot, 'garda-agent-orchestrator');
    const initAnswersPath = path.join(bundleRoot, 'runtime', 'init-answers.json');

    try {
        writeJson(initAnswersPath, {
            AssistantLanguage: 'English',
            AssistantBrevity: 'concise',
            SourceOfTruth: 'Codex',
            EnforceNoAutoCommit: 'false',
            ClaudeOrchestratorFullAccess: 'false',
            TokenEconomyEnabled: 'true',
            CollectedVia: 'CLI_NONINTERACTIVE',
            ActiveAgentFiles: 'AGENTS.md'
        });
        fs.writeFileSync(path.join(bundleRoot, 'MANIFEST.md'), '# Manifest\n', 'utf8');

        const result = runAgentInit({
            targetRoot: workspaceRoot,
            activeAgentFiles: 'AGENTS.md',
            projectRulesUpdated: 'no',
            skillsPrompted: 'yes',
            installRunner: function () {},
            verifyRunner: function () {
                return { passed: true };
            },
            manifestRunner: function () {
                return { passed: true };
            }
        });

        assert.equal(result.readyForTasks, false);
        assert.equal(result.projectRulesUpdated, false);
    } finally {
        fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
});

test('runAgentInit seeds workflow-config full-suite command from project stack while keeping the mode disabled', () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-agent-init-seed-'));
    const bundleRoot = path.join(workspaceRoot, 'garda-agent-orchestrator');
    const initAnswersPath = path.join(bundleRoot, 'runtime', 'init-answers.json');

    try {
        writeJson(initAnswersPath, {
            AssistantLanguage: 'English',
            AssistantBrevity: 'concise',
            SourceOfTruth: 'Codex',
            EnforceNoAutoCommit: 'false',
            ClaudeOrchestratorFullAccess: 'false',
            TokenEconomyEnabled: 'true',
            CollectedVia: 'CLI_NONINTERACTIVE',
            ActiveAgentFiles: 'AGENTS.md'
        });
        writeText(path.join(bundleRoot, 'VERSION'), '9.9.9-test\n');
        writeText(path.join(bundleRoot, 'MANIFEST.md'), '# Manifest\n');
        writeJson(path.join(bundleRoot, 'live', 'config', 'workflow-config.json'), {
            full_suite_validation: {
                enabled: false,
                command: '__FULL_SUITE_COMMAND_UNCONFIGURED__',
                timeout_ms: 600000,
                green_summary_max_lines: 5,
                red_failure_chunk_lines: 50,
                out_of_scope_failure_policy: 'AUDIT_AND_BLOCK'
            }
        });
        writeText(path.join(workspaceRoot, 'pyproject.toml'), '[tool.pytest.ini_options]\n');

        const result = runAgentInit({
            targetRoot: workspaceRoot,
            activeAgentFiles: 'AGENTS.md',
            projectRulesUpdated: 'yes',
            skillsPrompted: 'yes',
            installRunner: function () {},
            verifyRunner: function () {
                return { passed: true };
            },
            manifestRunner: function () {
                return { passed: true };
            }
        });

        assert.equal(result.readyForTasks, true);
        const workflowConfig = readWorkflowConfig(bundleRoot);
        const fullSuiteValidation = workflowConfig.full_suite_validation as Record<string, unknown>;
        assert.equal(fullSuiteValidation.enabled, false);
        assert.equal(fullSuiteValidation.command, 'pytest');
        assert.equal(Object.prototype.hasOwnProperty.call(workflowConfig, 'review_execution_policy'), false);

        const persistedState = JSON.parse(fs.readFileSync(result.agentInitStatePath, 'utf8'));
        assert.equal(persistedState.LastSeededFullSuiteCommand, 'pytest');
    } finally {
        fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
});

test('runAgentInit preserves legacy-compatible workflow-config omission when the file is missing on an existing bundle', () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-agent-init-missing-workflow-config-'));
    const bundleRoot = path.join(workspaceRoot, 'garda-agent-orchestrator');
    const initAnswersPath = path.join(bundleRoot, 'runtime', 'init-answers.json');

    try {
        writeJson(initAnswersPath, {
            AssistantLanguage: 'English',
            AssistantBrevity: 'concise',
            SourceOfTruth: 'Codex',
            EnforceNoAutoCommit: 'false',
            ClaudeOrchestratorFullAccess: 'false',
            TokenEconomyEnabled: 'true',
            CollectedVia: 'CLI_NONINTERACTIVE',
            ActiveAgentFiles: 'AGENTS.md'
        });
        writeText(path.join(bundleRoot, 'VERSION'), '9.9.9-test\n');
        writeText(path.join(bundleRoot, 'MANIFEST.md'), '# Manifest\n');
        writeText(path.join(workspaceRoot, 'pyproject.toml'), '[tool.pytest.ini_options]\n');

        runAgentInit({
            targetRoot: workspaceRoot,
            activeAgentFiles: 'AGENTS.md',
            projectRulesUpdated: 'yes',
            skillsPrompted: 'yes',
            installRunner: function () {},
            verifyRunner: function () {
                return { passed: true };
            },
            manifestRunner: function () {
                return { passed: true };
            }
        });

        const workflowConfig = readWorkflowConfig(bundleRoot);
        const fullSuiteValidation = workflowConfig.full_suite_validation as Record<string, unknown>;
        assert.equal(fullSuiteValidation.enabled, false);
        assert.equal(fullSuiteValidation.command, 'pytest');
        assert.equal(Object.prototype.hasOwnProperty.call(workflowConfig, 'review_execution_policy'), false);
    } finally {
        fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
});

test('runAgentInit preserves manual full-suite command overrides when they differ from the prior seeded default', () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-agent-init-manual-fsv-'));
    const bundleRoot = path.join(workspaceRoot, 'garda-agent-orchestrator');
    const initAnswersPath = path.join(bundleRoot, 'runtime', 'init-answers.json');

    try {
        writeJson(initAnswersPath, {
            AssistantLanguage: 'English',
            AssistantBrevity: 'concise',
            SourceOfTruth: 'Codex',
            EnforceNoAutoCommit: 'false',
            ClaudeOrchestratorFullAccess: 'false',
            TokenEconomyEnabled: 'true',
            CollectedVia: 'CLI_NONINTERACTIVE',
            ActiveAgentFiles: 'AGENTS.md'
        });
        writeText(path.join(bundleRoot, 'VERSION'), '9.9.9-test\n');
        writeText(path.join(bundleRoot, 'MANIFEST.md'), '# Manifest\n');
        writeJson(path.join(bundleRoot, 'live', 'config', 'workflow-config.json'), {
            full_suite_validation: {
                enabled: false,
                command: 'python -m pytest -q',
                timeout_ms: 600000,
                green_summary_max_lines: 5,
                red_failure_chunk_lines: 50,
                out_of_scope_failure_policy: 'AUDIT_AND_BLOCK'
            }
        });
        writeJson(path.join(bundleRoot, 'runtime', 'agent-init-state.json'), {
            Version: 1,
            UpdatedAt: new Date().toISOString(),
            OrchestratorVersion: '9.9.8-test',
            AssistantLanguage: 'English',
            SourceOfTruth: 'Codex',
            AssistantLanguageConfirmed: true,
            ActiveAgentFilesConfirmed: true,
            ProjectRulesUpdated: true,
            SkillsPromptCompleted: true,
            VerificationPassed: true,
            ManifestValidationPassed: true,
            ActiveAgentFiles: ['AGENTS.md'],
            LastSeededFullSuiteCommand: 'pytest'
        });
        writeText(path.join(workspaceRoot, 'pyproject.toml'), '[tool.pytest.ini_options]\n');

        const result = runAgentInit({
            targetRoot: workspaceRoot,
            activeAgentFiles: 'AGENTS.md',
            projectRulesUpdated: 'yes',
            skillsPrompted: 'yes',
            installRunner: function () {},
            verifyRunner: function () {
                return { passed: true };
            },
            manifestRunner: function () {
                return { passed: true };
            }
        });

        assert.equal(result.readyForTasks, true);
        const workflowConfig = readWorkflowConfig(bundleRoot);
        const fullSuiteValidation = workflowConfig.full_suite_validation as Record<string, unknown>;
        assert.equal(fullSuiteValidation.command, 'python -m pytest -q');

        const persistedState = JSON.parse(fs.readFileSync(result.agentInitStatePath, 'utf8'));
        assert.equal(persistedState.LastSeededFullSuiteCommand, 'pytest');
    } finally {
        fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
});

test('runAgentInit preserves manual full-suite command overrides across later detected stack changes', () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-agent-init-manual-fsv-stack-change-'));
    const bundleRoot = path.join(workspaceRoot, 'garda-agent-orchestrator');
    const initAnswersPath = path.join(bundleRoot, 'runtime', 'init-answers.json');

    try {
        writeJson(initAnswersPath, {
            AssistantLanguage: 'English',
            AssistantBrevity: 'concise',
            SourceOfTruth: 'Codex',
            EnforceNoAutoCommit: 'false',
            ClaudeOrchestratorFullAccess: 'false',
            TokenEconomyEnabled: 'true',
            CollectedVia: 'CLI_NONINTERACTIVE',
            ActiveAgentFiles: 'AGENTS.md'
        });
        writeText(path.join(bundleRoot, 'VERSION'), '9.9.9-test\n');
        writeText(path.join(bundleRoot, 'MANIFEST.md'), '# Manifest\n');
        writeJson(path.join(bundleRoot, 'live', 'config', 'workflow-config.json'), {
            full_suite_validation: {
                enabled: false,
                command: 'python -m pytest -q',
                timeout_ms: 600000,
                green_summary_max_lines: 5,
                red_failure_chunk_lines: 50,
                out_of_scope_failure_policy: 'AUDIT_AND_BLOCK'
            }
        });
        writeJson(path.join(bundleRoot, 'runtime', 'agent-init-state.json'), {
            Version: 1,
            UpdatedAt: new Date().toISOString(),
            OrchestratorVersion: '9.9.8-test',
            AssistantLanguage: 'English',
            SourceOfTruth: 'Codex',
            AssistantLanguageConfirmed: true,
            ActiveAgentFilesConfirmed: true,
            ProjectRulesUpdated: true,
            SkillsPromptCompleted: true,
            VerificationPassed: true,
            ManifestValidationPassed: true,
            ActiveAgentFiles: ['AGENTS.md'],
            LastSeededFullSuiteCommand: 'pytest'
        });
        writeJson(path.join(workspaceRoot, 'package.json'), {
            packageManager: 'pnpm@9.0.0',
            scripts: {
                test: 'vitest run'
            }
        });
        writeText(path.join(workspaceRoot, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n');

        const result = runAgentInit({
            targetRoot: workspaceRoot,
            activeAgentFiles: 'AGENTS.md',
            projectRulesUpdated: 'yes',
            skillsPrompted: 'yes',
            installRunner: function () {},
            verifyRunner: function () {
                return { passed: true };
            },
            manifestRunner: function () {
                return { passed: true };
            }
        });

        assert.equal(result.readyForTasks, true);
        const workflowConfig = readWorkflowConfig(bundleRoot);
        const fullSuiteValidation = workflowConfig.full_suite_validation as Record<string, unknown>;
        assert.equal(fullSuiteValidation.command, 'python -m pytest -q');

        const persistedState = JSON.parse(fs.readFileSync(result.agentInitStatePath, 'utf8'));
        assert.equal(persistedState.LastSeededFullSuiteCommand, 'pytest');
    } finally {
        fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
});

test('runAgentInit preserves existing workflow-config toggles while seeding only the detected command', () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-agent-init-workflow-config-preserve-'));
    const bundleRoot = path.join(workspaceRoot, 'garda-agent-orchestrator');
    const initAnswersPath = path.join(bundleRoot, 'runtime', 'init-answers.json');

    try {
        writeJson(initAnswersPath, {
            AssistantLanguage: 'English',
            AssistantBrevity: 'concise',
            SourceOfTruth: 'Codex',
            EnforceNoAutoCommit: 'false',
            ClaudeOrchestratorFullAccess: 'false',
            TokenEconomyEnabled: 'true',
            CollectedVia: 'CLI_NONINTERACTIVE',
            ActiveAgentFiles: 'AGENTS.md'
        });
        writeText(path.join(bundleRoot, 'VERSION'), '9.9.9-test\n');
        writeText(path.join(bundleRoot, 'MANIFEST.md'), '# Manifest\n');
        writeJson(path.join(bundleRoot, 'live', 'config', 'workflow-config.json'), {
            full_suite_validation: {
                enabled: true,
                command: '__FULL_SUITE_COMMAND_UNCONFIGURED__',
                timeout_ms: 600000,
                green_summary_max_lines: 5,
                red_failure_chunk_lines: 50,
                out_of_scope_failure_policy: 'AUDIT_AND_WARN',
                auto_open_report: true
            },
            review_execution_policy: {
                mode: 'strict_sequential'
            }
        });
        writeText(path.join(workspaceRoot, 'pyproject.toml'), '[tool.pytest.ini_options]\n');

        runAgentInit({
            targetRoot: workspaceRoot,
            activeAgentFiles: 'AGENTS.md',
            projectRulesUpdated: 'yes',
            skillsPrompted: 'yes',
            installRunner: function () {},
            verifyRunner: function () {
                return { passed: true };
            },
            manifestRunner: function () {
                return { passed: true };
            }
        });

        const workflowConfig = readWorkflowConfig(bundleRoot);
        const fullSuiteValidation = workflowConfig.full_suite_validation as Record<string, unknown>;
        assert.equal(fullSuiteValidation.enabled, true);
        assert.equal(fullSuiteValidation.command, 'pytest');
        assert.equal(fullSuiteValidation.out_of_scope_failure_policy, 'AUDIT_AND_WARN');
        assert.equal(fullSuiteValidation.auto_open_report, true);
        assert.deepEqual(workflowConfig.review_execution_policy, {
            mode: 'strict_sequential'
        });
    } finally {
        fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
});

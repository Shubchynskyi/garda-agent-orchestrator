import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import { runAgentInit } from '../../../src/lifecycle/agent-init';

function writeJson(filePath: string, value: unknown) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
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

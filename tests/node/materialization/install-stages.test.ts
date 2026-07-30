import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { getRequiredReviewSkillBridgeHostEntry } from '../../../src/core/provider-registry';
import {
    MANAGED_END,
    MANAGED_START
} from '../../../src/materialization/content-builders';
import {
    runInstallPrimaryEntrypointStage,
    runInstallProviderEntrypointStage
} from '../../../src/materialization/install/install-entrypoint-stage';
import { runInstallFinalizationStage } from '../../../src/materialization/install/install-finalization-stage';
import { createInstallFilesystemStage } from '../../../src/materialization/install/install-filesystem-stage';
import {
    runInstallEditorSettingsStage,
    runInstallIgnoreStage
} from '../../../src/materialization/install/install-settings-stage';
import { runInstallTaskStage } from '../../../src/materialization/install/install-task-stage';

function findRepoRoot(): string {
    let current = __dirname;
    while (current !== path.dirname(current)) {
        if (
            fs.existsSync(path.join(current, 'VERSION'))
            && fs.existsSync(path.join(current, 'template'))
        ) {
            return current;
        }
        current = path.dirname(current);
    }
    throw new Error('Cannot find repo root');
}

function createFilesystemStage(targetRoot: string) {
    return createInstallFilesystemStage({
        targetRoot,
        backupRoot: path.join(targetRoot, 'runtime', 'backups', 'install-stage-test'),
        dryRun: false,
        skipBackups: false,
        deploymentDate: '2026-07-30',
        canonicalEntryFile: 'AGENTS.md'
    });
}

function writeLegacyManagedEntrypoint(targetRoot: string, relativePath: string): void {
    const entrypointPath = path.join(targetRoot, relativePath);
    fs.mkdirSync(path.dirname(entrypointPath), { recursive: true });
    fs.writeFileSync(
        entrypointPath,
        `${MANAGED_START}\nlegacy managed content\n${MANAGED_END}\n`,
        'utf8'
    );
}

describe('install materialization stages', () => {
    const repoRoot = findRepoRoot();

    it('materializes TASK.md through the task-stage filesystem contract', () => {
        const targetRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-install-task-stage-'));
        const sourceRoot = path.join(targetRoot, 'bundle-template');
        try {
            fs.mkdirSync(sourceRoot, { recursive: true });
            fs.copyFileSync(
                path.join(repoRoot, 'template', 'TASK.md'),
                path.join(sourceRoot, 'TASK.md')
            );
            const filesystem = createFilesystemStage(targetRoot);

            runInstallTaskStage({
                sourceRoot,
                targetRoot,
                dryRun: false,
                preserveExisting: true,
                answerDependentOnly: false,
                filesystem
            });

            const taskContent = fs.readFileSync(
                path.join(targetRoot, 'TASK.md'),
                'utf8'
            );
            assert.equal(taskContent.includes('{{DEPLOYMENT_DATE}}'), false);
            assert.equal(taskContent.includes('{{CANONICAL_ENTRYPOINT}}'), false);
            assert.match(taskContent, /2026-07-30/);
            assert.match(taskContent, /AGENTS\.md/);
            assert.equal(filesystem.metrics.deployed, 1);
        } finally {
            fs.rmSync(targetRoot, { recursive: true, force: true });
        }
    });

    it('materializes canonical, redirect, and shared router entrypoints through explicit stages', () => {
        const targetRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-install-entry-stage-'));
        try {
            const filesystem = createFilesystemStage(targetRoot);
            runInstallPrimaryEntrypointStage({
                sourceRoot: path.join(repoRoot, 'template'),
                canonicalEntryFile: 'AGENTS.md',
                redirectEntryFiles: ['CLAUDE.md'],
                providerBridgePaths: [],
                filesystem
            });
            const providerResult = runInstallProviderEntrypointStage({
                targetRoot,
                canonicalEntryFile: 'AGENTS.md',
                redirectEntryFiles: ['CLAUDE.md'],
                providerOrchestratorProfiles: [],
                githubSkillBridgeProfiles: [],
                providerMinimalism: false,
                reviewSkillBridgeHostEntrypoint:
                    getRequiredReviewSkillBridgeHostEntry().entrypointFile,
                providerBridgePaths: [],
                filesystem
            });

            assert.match(
                fs.readFileSync(path.join(targetRoot, 'AGENTS.md'), 'utf8'),
                /garda-agent-orchestrator:managed-start/
            );
            assert.match(
                fs.readFileSync(path.join(targetRoot, 'CLAUDE.md'), 'utf8'),
                /This file is a redirect\./
            );
            assert.ok(fs.existsSync(path.join(
                targetRoot,
                '.agents',
                'workflows',
                'start-task.md'
            )));
            assert.equal(providerResult.preserved, 0);
        } finally {
            fs.rmSync(targetRoot, { recursive: true, force: true });
        }
    });

    it('preserves an existing managed provider entrypoint when minimalism is disabled', () => {
        const targetRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-install-preserve-stage-'));
        const legacyEntrypoint = 'GEMINI.md';
        try {
            writeLegacyManagedEntrypoint(targetRoot, legacyEntrypoint);
            const filesystem = createFilesystemStage(targetRoot);

            const result = runInstallProviderEntrypointStage({
                targetRoot,
                canonicalEntryFile: 'AGENTS.md',
                redirectEntryFiles: [],
                providerOrchestratorProfiles: [],
                githubSkillBridgeProfiles: [],
                providerMinimalism: false,
                reviewSkillBridgeHostEntrypoint:
                    getRequiredReviewSkillBridgeHostEntry().entrypointFile,
                providerBridgePaths: [],
                filesystem
            });

            const content = fs.readFileSync(
                path.join(targetRoot, legacyEntrypoint),
                'utf8'
            );
            assert.equal(result.preserved, 1);
            assert.match(content, /This file is a redirect\./);
            assert.match(content, /AGENTS\.md/);
            assert.equal(content.includes('legacy managed content'), false);
        } finally {
            fs.rmSync(targetRoot, { recursive: true, force: true });
        }
    });

    it('removes a stale managed provider entrypoint when minimalism is enabled', () => {
        const targetRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-install-minimal-stage-'));
        const staleEntrypoint = 'GEMINI.md';
        try {
            writeLegacyManagedEntrypoint(targetRoot, staleEntrypoint);
            const filesystem = createFilesystemStage(targetRoot);

            const result = runInstallProviderEntrypointStage({
                targetRoot,
                canonicalEntryFile: 'AGENTS.md',
                redirectEntryFiles: [],
                providerOrchestratorProfiles: [],
                githubSkillBridgeProfiles: [],
                providerMinimalism: true,
                reviewSkillBridgeHostEntrypoint:
                    getRequiredReviewSkillBridgeHostEntry().entrypointFile,
                providerBridgePaths: [],
                filesystem
            });

            assert.equal(result.preserved, 0);
            assert.equal(
                fs.existsSync(path.join(targetRoot, staleEntrypoint)),
                false
            );
            assert.equal(filesystem.metrics.aligned, 1);
        } finally {
            fs.rmSync(targetRoot, { recursive: true, force: true });
        }
    });

    it('materializes editor and ignore settings through separate stage contracts', () => {
        const targetRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-install-settings-stage-'));
        const bundleRoot = path.join(targetRoot, 'garda-agent-orchestrator');
        try {
            fs.mkdirSync(bundleRoot, { recursive: true });
            const filesystem = createFilesystemStage(targetRoot);
            const editorResult = runInstallEditorSettingsStage({
                targetRoot,
                dryRun: false,
                preserveExisting: true,
                canonicalEntryFile: 'AGENTS.md',
                enableClaudeOrchestratorFullAccess: true,
                filesystem
            });
            const ignoreResult = runInstallIgnoreStage({
                targetRoot,
                bundleRoot,
                dryRun: false,
                activeEntryFiles: ['AGENTS.md'],
                providerOrchestratorProfiles: [],
                enableClaudeOrchestratorFullAccess: true,
                providerMinimalism: true,
                qwenExists: editorResult.qwenExists,
                filesystem
            });

            assert.equal(editorResult.qwenSettingsParseMode, 'not-present');
            assert.equal(editorResult.claudeLocalSettingsUpdated, true);
            assert.equal(editorResult.vscodeSettingsUpdated, true);
            assert.ok(fs.existsSync(path.join(
                targetRoot,
                '.claude',
                'settings.local.json'
            )));
            assert.ok(fs.existsSync(path.join(
                targetRoot,
                '.vscode',
                'settings.json'
            )));
            assert.ok(ignoreResult.gitignoreEntriesAdded > 0);
            assert.equal(ignoreResult.agentignoreUpdated, true);
        } finally {
            fs.rmSync(targetRoot, { recursive: true, force: true });
        }
    });

    it('invokes init and writes version evidence through the finalization stage', () => {
        const targetRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-install-final-stage-'));
        const liveVersionPath = path.join(
            targetRoot,
            'garda-agent-orchestrator',
            'live',
            'version.json'
        );
        let capturedSourceOfTruth = '';
        try {
            const result = runInstallFinalizationStage({
                targetRoot,
                normalizedTarget: path.resolve(targetRoot),
                liveVersionPath,
                dryRun: false,
                switchModeBeforeInstall: 'on',
                bundleVersion: '1.2.0',
                resolvedInitPath: path.join(targetRoot, 'runtime', 'init-answers.json'),
                sourceOfTruth: 'Codex',
                canonicalEntryFile: 'AGENTS.md',
                activeEntryFiles: ['AGENTS.md'],
                assistantLanguage: 'English',
                assistantBrevity: 'concise',
                enforceNoAutoCommit: false,
                enableClaudeOrchestratorFullAccess: false,
                tokenEconomyEnabled: true,
                providerMinimalism: true,
                runInit: true,
                initRunner: (options) => {
                    capturedSourceOfTruth = options.sourceOfTruth;
                    return { workflowConfigMergeStatus: 'stage-test' };
                },
                activeEntryFilesSeed: 'AGENTS.md',
                preserveLegacyReviewExecutionPolicyOmission: false
            });

            const version = JSON.parse(
                fs.readFileSync(liveVersionPath, 'utf8')
            ) as Record<string, unknown>;
            assert.equal(capturedSourceOfTruth, 'Codex');
            assert.equal(result.initInvoked, true);
            assert.equal(
                result.initResult?.workflowConfigMergeStatus,
                'stage-test'
            );
            assert.equal(result.liveVersionWritten, true);
            assert.equal(result.protectedControlPlaneManifestWritten, true);
            assert.equal(version.CanonicalEntrypoint, 'AGENTS.md');
            assert.equal(version.ActiveAgentFiles, 'AGENTS.md');
        } finally {
            fs.rmSync(targetRoot, { recursive: true, force: true });
        }
    });
});

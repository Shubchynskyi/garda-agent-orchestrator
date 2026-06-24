import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawnSync } from 'node:child_process';

import { runCheckUpdate } from '../../../src/lifecycle/check-update';
import { runUpdate, getUpdateRollbackItems } from '../../../src/lifecycle/update';
import { runUpdateFromGit } from '../../../src/lifecycle/update-git';
import { getLifecycleOperationLockPath, getUpdateSentinelPath, removePathRecursive, writeUpdateSentinel } from '../../../src/lifecycle/common';
import { UNCONFIGURED_COMPILE_GATE_COMMAND } from '../../../src/core/constants';
import { buildDefaultWorkflowConfig } from '../../../src/core/workflow-config';
import { createAgentInitState, writeAgentInitState } from '../../../src/runtime/agent-init-state';

function findRepoRoot() {
    let dir = __dirname;
    while (dir !== path.dirname(dir)) {
        if (fs.existsSync(path.join(dir, 'VERSION')) && fs.existsSync(path.join(dir, 'template'))) {
            return dir;
        }
        dir = path.dirname(dir);
    }
    throw new Error('Cannot find repo root');
}

function copyDirRecursive(src: string, dst: string) {
    fs.mkdirSync(dst, { recursive: true });
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
        const srcPath = path.join(src, entry.name);
        const dstPath = path.join(dst, entry.name);
        if (entry.isDirectory()) {
            copyDirRecursive(srcPath, dstPath);
        } else {
            fs.copyFileSync(srcPath, dstPath);
        }
    }
}

function seedExecutableBundleSurface(repoRoot: string, bundleRoot: string) {
    fs.copyFileSync(path.join(repoRoot, 'package.json'), path.join(bundleRoot, 'package.json'));
    copyDirRecursive(path.join(repoRoot, 'bin'), path.join(bundleRoot, 'bin'));
    fs.mkdirSync(path.join(bundleRoot, 'dist', 'src'), { recursive: true });
    fs.writeFileSync(path.join(bundleRoot, 'dist', 'src', 'index.js'), 'module.exports = {};', 'utf8');
}

function seedStaleTaskEventLock(bundleRoot: string, lockName: string) {
    const lockPath = path.join(bundleRoot, 'runtime', 'task-events', lockName);
    const oldDate = new Date('2020-01-01T00:00:00.000Z');
    fs.mkdirSync(lockPath, { recursive: true });
    fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
        pid: 999999,
        hostname: os.hostname(),
        created_at_utc: '2020-01-01T00:00:00.000Z'
    }), 'utf8');
    fs.utimesSync(path.join(lockPath, 'owner.json'), oldDate, oldDate);
    fs.utimesSync(lockPath, oldDate, oldDate);
}

function seedActiveTaskEventLock(bundleRoot: string, lockName: string) {
    const lockPath = path.join(bundleRoot, 'runtime', 'task-events', lockName);
    const now = new Date().toISOString();
    fs.mkdirSync(lockPath, { recursive: true });
    fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
        pid: process.pid,
        hostname: os.hostname(),
        created_at_utc: now,
        heartbeat_at_utc: now
    }), 'utf8');
}

function seedLifecycleOperationLock(projectRoot: string, pid: number, hostname: string = os.hostname()) {
    const lockPath = getLifecycleOperationLockPath(projectRoot);
    fs.mkdirSync(lockPath, { recursive: true });
    fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
        pid,
        hostname,
        operation: 'update',
        acquired_at_utc: '2026-04-05T00:00:00.000Z',
        target_root: path.resolve(projectRoot)
    }, null, 2), 'utf8');
    return lockPath;
}

function seedOffModeState(bundleRoot: string) {
    const switchRoot = path.join(bundleRoot, 'runtime', 'switch');
    fs.mkdirSync(switchRoot, { recursive: true });
    fs.writeFileSync(path.join(switchRoot, 'state.json'), JSON.stringify({
        schema_version: 1,
        mode: 'off',
        updated_at_utc: '2026-05-24T00:00:00.000Z',
        candidates: [],
        root_files: [],
        off_storage_files: [],
        on_storage_files: []
    }, null, 2), 'utf8');
}

function seedPrimaryInitializedWorkspace(projectRoot: string, bundleRoot: string, options: {
    compileGateCommand?: string;
    agentInitComplete?: boolean;
} = {}) {
    fs.writeFileSync(path.join(projectRoot, 'TASK.md'), '# TASK.md\n', 'utf8');
    fs.writeFileSync(path.join(bundleRoot, 'live', 'USAGE.md'), '# Usage\n', 'utf8');
    fs.mkdirSync(path.join(bundleRoot, 'live', 'docs', 'agent-rules'), { recursive: true });
    fs.writeFileSync(
        path.join(bundleRoot, 'live', 'docs', 'agent-rules', '40-commands.md'),
        '# Commands\n\n- Compile: npm run build\n- Test: npm test\n',
        'utf8'
    );
    fs.mkdirSync(path.join(bundleRoot, 'live', 'config'), { recursive: true });
    const workflowConfig = buildDefaultWorkflowConfig();
    workflowConfig.compile_gate.command = options.compileGateCommand ?? UNCONFIGURED_COMPILE_GATE_COMMAND;
    fs.writeFileSync(
        path.join(bundleRoot, 'live', 'config', 'workflow-config.json'),
        JSON.stringify(workflowConfig, null, 2) + '\n',
        'utf8'
    );

    writeAgentInitState(projectRoot, createAgentInitState({
        AssistantLanguage: 'English',
        SourceOfTruth: 'Claude',
        AssistantLanguageConfirmed: true,
        ActiveAgentFilesConfirmed: true,
        ProjectRulesUpdated: true,
        SkillsPromptCompleted: true,
        OrdinaryDocPathsConfirmed: true,
        VerificationPassed: options.agentInitComplete === true,
        ManifestValidationPassed: options.agentInitComplete === true,
        ActiveAgentFiles: ['CLAUDE.md'],
        ProjectMemoryInitialized: true,
        ProjectMemoryValidated: true,
        ProjectMemoryMode: 'update',
        ProjectMemoryDir: 'garda-agent-orchestrator/live/docs/project-memory',
        ProjectMemoryReadFirst: ['README.md'],
        ProjectMemorySummaryRule: 'garda-agent-orchestrator/live/docs/agent-rules/15-project-memory.md'
    }));
}

function seedPrimaryInitializedWorkspaceWithoutAgentInitState(
    projectRoot: string,
    bundleRoot: string,
    options: { compileGateCommand?: string } = {}
) {
    fs.writeFileSync(path.join(projectRoot, 'TASK.md'), '# TASK.md\n', 'utf8');
    fs.writeFileSync(path.join(bundleRoot, 'live', 'USAGE.md'), '# Usage\n', 'utf8');
    fs.mkdirSync(path.join(bundleRoot, 'live', 'docs', 'agent-rules'), { recursive: true });
    fs.writeFileSync(
        path.join(bundleRoot, 'live', 'docs', 'agent-rules', '40-commands.md'),
        '# Commands\n\n- Compile: npm run build\n- Test: npm test\n',
        'utf8'
    );
    fs.mkdirSync(path.join(bundleRoot, 'live', 'config'), { recursive: true });
    const workflowConfig = buildDefaultWorkflowConfig();
    workflowConfig.compile_gate.command = options.compileGateCommand ?? 'npm run build';
    fs.writeFileSync(
        path.join(bundleRoot, 'live', 'config', 'workflow-config.json'),
        JSON.stringify(workflowConfig, null, 2) + '\n',
        'utf8'
    );
}

function seedGitRepository(repoPath: string) {
    const commands = [
        ['init'],
        ['config', 'user.email', 'test@example.com'],
        ['config', 'user.name', 'Garda Test'],
        ['add', '.'],
        ['commit', '-m', 'seed update source']
    ];
    for (const args of commands) {
        const result = spawnSync('git', args, { cwd: repoPath, encoding: 'utf8' });
        assert.equal(
            result.status,
            0,
            `git ${args.join(' ')} failed: ${result.stderr || result.stdout}`
        );
    }
}

function setupUpdateWorkspace(repoRoot: string) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-update-'));
    const bundle = path.join(tmpDir, 'garda-agent-orchestrator');
    fs.mkdirSync(bundle, { recursive: true });

    // Copy VERSION
    fs.copyFileSync(path.join(repoRoot, 'VERSION'), path.join(bundle, 'VERSION'));
    seedExecutableBundleSurface(repoRoot, bundle);

    // Copy template
    copyDirRecursive(path.join(repoRoot, 'template'), path.join(bundle, 'template'));

    // Create live dir
    fs.mkdirSync(path.join(bundle, 'live', 'config'), { recursive: true });
    fs.mkdirSync(path.join(bundle, 'live', 'docs', 'agent-rules'), { recursive: true });

    // Create runtime dir
    fs.mkdirSync(path.join(bundle, 'runtime'), { recursive: true });

    // Write init-answers.json
    const answers = {
        AssistantLanguage: 'English',
        AssistantBrevity: 'concise',
        SourceOfTruth: 'Claude',
        EnforceNoAutoCommit: 'false',
        ClaudeOrchestratorFullAccess: 'false',
        TokenEconomyEnabled: 'true',
        CollectedVia: 'CLI_NONINTERACTIVE'
    };
    const answersPath = path.join(bundle, 'runtime', 'init-answers.json');
    fs.writeFileSync(answersPath, JSON.stringify(answers, null, 2));

    // Create .git dir for install
    fs.mkdirSync(path.join(tmpDir, '.git', 'hooks'), { recursive: true });

    return {
        projectRoot: tmpDir,
        bundleRoot: bundle,
        answersPath: path.relative(tmpDir, answersPath).replace(/\\/g, '/')
    };
}

function setupSyncedUpdateWorkspace(repoRoot: string) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-update-synced-'));
    const bundle = path.join(tmpDir, 'garda-agent-orchestrator');
    fs.mkdirSync(bundle, { recursive: true });

    const exactFiles = [
        '.gitattributes',
        'AGENT_INIT_PROMPT.md',
        'CHANGELOG.md',
        'HOW_TO.md',
        'LICENSE',
        'MANIFEST.md',
        'README.md',
        'VERSION',
        'package.json'
    ];
    for (const relativePath of exactFiles) {
        fs.copyFileSync(path.join(repoRoot, relativePath), path.join(bundle, relativePath));
    }

    copyDirRecursive(path.join(repoRoot, 'bin'), path.join(bundle, 'bin'));
    fs.mkdirSync(path.join(bundle, 'dist', 'src'), { recursive: true });
    fs.writeFileSync(path.join(bundle, 'dist', 'src', 'index.js'), 'module.exports = {};', 'utf8');
    copyDirRecursive(path.join(repoRoot, 'src'), path.join(bundle, 'src'));
    copyDirRecursive(path.join(repoRoot, 'template'), path.join(bundle, 'template'));

    fs.mkdirSync(path.join(bundle, 'live', 'config'), { recursive: true });
    fs.mkdirSync(path.join(bundle, 'live', 'docs', 'agent-rules'), { recursive: true });
    fs.mkdirSync(path.join(bundle, 'runtime'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, '.git', 'hooks'), { recursive: true });

    const answers = {
        AssistantLanguage: 'English',
        AssistantBrevity: 'concise',
        SourceOfTruth: 'Claude',
        EnforceNoAutoCommit: 'false',
        ClaudeOrchestratorFullAccess: 'false',
        TokenEconomyEnabled: 'true',
        CollectedVia: 'CLI_NONINTERACTIVE'
    };
    const answersPath = path.join(bundle, 'runtime', 'init-answers.json');
    fs.writeFileSync(answersPath, JSON.stringify(answers, null, 2));

    return {
        projectRoot: tmpDir,
        bundleRoot: bundle,
        answersPath: path.relative(tmpDir, answersPath).replace(/\\/g, '/')
    };
}

describe('getUpdateRollbackItems', () => {
    it('returns expected items including init answers', () => {
        const dir = os.tmpdir();
        const answersPath = path.join(dir, 'garda-agent-orchestrator', 'runtime', 'init-answers.json');
        const items = getUpdateRollbackItems(dir, answersPath);

        assert.ok(items.includes('CLAUDE.md'));
        assert.ok(items.includes('AGENTS.md'));
        assert.ok(items.includes('TASK.md'));
        assert.ok(items.includes('.gitignore'));
        assert.ok(items.includes('garda-agent-orchestrator/VERSION'));
        assert.ok(items.includes('garda-agent-orchestrator/live'));
        assert.ok(items.includes('garda-agent-orchestrator/live/docs/project-memory'),
            'project-memory must be in rollback items (T-072)');
        // init answers path should be included
        assert.ok(items.some((p) => p.includes('init-answers.json')));
    });
});

describe('runUpdate', () => {
    const repoRoot = findRepoRoot();
    it('runs install and produces update report', () => {
        const { projectRoot, bundleRoot, answersPath } = setupUpdateWorkspace(repoRoot);
        try {
            const result = runUpdate({
                targetRoot: projectRoot,
                bundleRoot,
                initAnswersPath: answersPath,
                trustContext: {
                    policy: 'overridden',
                    overrideUsed: true,
                    overrideSource: 'cli-flag',
                    sourceType: 'path',
                    sourceReference: '/tmp/local-source'
                },
                skipVerify: true,
                skipManifestValidation: true
            });

            assert.equal(result.installStatus, 'PASS');
            assert.equal(result.materializationStatus, 'PASS');
            assert.equal(result.rollbackStatus, 'NOT_TRIGGERED');
            assert.ok(result.rollbackSnapshotCreated);
            assert.ok(result.rollbackRecordCount > 0);
            assert.ok(fs.existsSync(path.join(projectRoot, result.rollbackRecordsPath)));
            assert.equal(result.verifyStatus, 'SKIPPED');
            assert.equal(result.manifestValidationStatus, 'SKIPPED');

            // Update report should be written
            const reportPath = path.join(projectRoot, result.updateReportPath);
            assert.ok(fs.existsSync(reportPath));
            const reportContent = fs.readFileSync(reportPath, 'utf8');
            assert.ok(reportContent.includes('# Update Report'));
            assert.ok(reportContent.includes('Install: PASS'));
            assert.ok(reportContent.includes('Materialization: PASS'));
            assert.ok(reportContent.includes('TrustPolicy: overridden'));
            assert.ok(reportContent.includes('TrustOverrideUsed: yes'));
            assert.ok(reportContent.includes('TrustOverrideSource: cli-flag'));
        } finally {
            removePathRecursive(projectRoot);
        }
    });

    it('preserves TASK.md queue and lower local block during ordinary update when managed-end is missing', () => {
        const { projectRoot, bundleRoot, answersPath } = setupUpdateWorkspace(repoRoot);
        try {
            fs.writeFileSync(
                path.join(projectRoot, 'TASK.md'),
                [
                    '<!-- garda-agent-orchestrator:managed-start -->',
                    '# TASK.md',
                    '',
                    'Old generated header.',
                    '',
                    '## Active Queue',
                    '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
                    '|---|---|---|---|---|---|---|---|---|',
                    '| T-237 | 🟦 TODO | P0 | reliability | Keep live queue | gpt-5.4 | 2026-04-24 | balanced | preserve me |',
                    '',
                    '',
                    '## Блок очереди',
                    '',
                    '- `T-237` — нижний блок должен сохраниться.'
                ].join('\n'),
                'utf8'
            );

            const result = runUpdate({
                targetRoot: projectRoot,
                bundleRoot,
                initAnswersPath: answersPath,
                skipVerify: true,
                skipManifestValidation: true
            });

            assert.equal(result.installStatus, 'PASS');
            const taskContent = fs.readFileSync(path.join(projectRoot, 'TASK.md'), 'utf8');
            assert.ok(taskContent.includes('Canonical instructions entrypoint for orchestration: `CLAUDE.md`.'));
            assert.match(taskContent, /\| T-237 \| 🟦 TODO \| P0\s+\| reliability \| Keep live queue \| gpt-5\.4 \| 2026-04-24 \| balanced \| preserve me \|/);
            assert.ok(taskContent.includes('## Блок очереди'));
            assert.ok(taskContent.includes('- `T-237` — нижний блок должен сохраниться.'));
            assert.ok(taskContent.includes('garda-agent-orchestrator:managed-end'));
            assert.ok(!taskContent.includes('Old generated header.'));
            assert.ok(!taskContent.includes('| T-001 |'));
        } finally {
            removePathRecursive(projectRoot);
        }
    });

    it('supports dry-run mode', () => {
        const { projectRoot, bundleRoot, answersPath } = setupUpdateWorkspace(repoRoot);
        try {
            const result = runUpdate({
                targetRoot: projectRoot,
                bundleRoot,
                initAnswersPath: answersPath,
                dryRun: true
            });

            assert.equal(result.installStatus, 'PASS');
            assert.equal(result.materializationStatus, 'SKIPPED_DRY_RUN');
            assert.equal(result.verifyStatus, 'SKIPPED_DRY_RUN');
            assert.equal(result.manifestValidationStatus, 'SKIPPED_DRY_RUN');
            assert.equal(result.rollbackStatus, 'NOT_NEEDED');
            assert.ok(!result.rollbackSnapshotCreated);
            assert.equal(result.updateReportPath, 'not-generated-in-dry-run');
        } finally {
            removePathRecursive(projectRoot);
        }
    });

    it('blocks check-update apply when another lifecycle operation lock exists', async () => {
        const { projectRoot, bundleRoot } = setupSyncedUpdateWorkspace(repoRoot);
        try {
            const sourceBundleRoot = path.join(projectRoot, 'update-source');
            copyDirRecursive(bundleRoot, sourceBundleRoot);
            fs.writeFileSync(path.join(sourceBundleRoot, 'VERSION'), '9.9.9\n', 'utf8');
            seedLifecycleOperationLock(projectRoot, process.pid);

            await assert.rejects(() => runCheckUpdate({
                targetRoot: projectRoot,
                bundleRoot,
                sourcePath: sourceBundleRoot,
                diagnosticTool: 'git',
                apply: true,
                noPrompt: true,
                trustOverride: true,
                updateRunner() {
                    throw new Error('updateRunner should not execute while lifecycle lock is held');
                }
            }), /Another lifecycle operation is already running/);

            assert.equal(fs.readFileSync(path.join(bundleRoot, 'VERSION'), 'utf8').trim(), fs.readFileSync(path.join(repoRoot, 'VERSION'), 'utf8').trim());
            assert.ok(!fs.existsSync(path.join(bundleRoot, 'runtime', 'bundle-backups')), 'apply must stop before bundle sync starts');
        } finally {
            removePathRecursive(projectRoot);
        }
    });

    it('blocks check-update apply in off mode before source acquisition or sync', async () => {
        const { projectRoot, bundleRoot } = setupSyncedUpdateWorkspace(repoRoot);
        try {
            seedOffModeState(bundleRoot);

            await assert.rejects(() => runCheckUpdate({
                targetRoot: projectRoot,
                bundleRoot,
                sourcePath: path.join(projectRoot, 'missing-update-source'),
                apply: true,
                noPrompt: true,
                trustOverride: true,
                updateRunner() {
                    throw new Error('updateRunner should not execute while Garda is off');
                }
            }), /GARDA_UPDATE_OFF_MODE_BLOCKED: update apply cannot apply while Garda is off.*garda on/);

            assert.ok(!fs.existsSync(path.join(bundleRoot, 'runtime', 'bundle-backups')), 'off-mode check-update apply must stop before bundle sync starts');
        } finally {
            removePathRecursive(projectRoot);
        }
    });

    it('allows check-update read-only mode while Garda is off', async () => {
        const { projectRoot, bundleRoot } = setupSyncedUpdateWorkspace(repoRoot);
        try {
            const sourceBundleRoot = path.join(projectRoot, 'update-source');
            copyDirRecursive(bundleRoot, sourceBundleRoot);
            fs.writeFileSync(path.join(sourceBundleRoot, 'VERSION'), '9.9.9\n', 'utf8');
            seedOffModeState(bundleRoot);

            const result = await runCheckUpdate({
                targetRoot: projectRoot,
                bundleRoot,
                sourcePath: sourceBundleRoot,
                apply: false,
                noPrompt: true,
                trustOverride: true,
                updateRunner() {
                    throw new Error('updateRunner should not execute for read-only checks');
                }
            });

            assert.equal(result.updateApplied, false);
            assert.equal(result.checkUpdateResult, 'UPDATE_AVAILABLE');
            assert.equal(result.updateAvailable, true);
            assert.ok(!fs.existsSync(path.join(bundleRoot, 'runtime', 'bundle-backups')), 'read-only off-mode check must not sync bundle items');
        } finally {
            removePathRecursive(projectRoot);
        }
    });

    it('blocks update git apply in off mode before cloning the update source', async () => {
        const { projectRoot, bundleRoot } = setupSyncedUpdateWorkspace(repoRoot);
        try {
            seedOffModeState(bundleRoot);

            await assert.rejects(() => runUpdateFromGit({
                targetRoot: projectRoot,
                bundleRoot,
                branch: 'dev',
                updateRunner() {
                    throw new Error('updateRunner should not execute while Garda is off');
                }
            }), /GARDA_UPDATE_OFF_MODE_BLOCKED: update git cannot apply while Garda is off.*garda on/);

            assert.ok(!fs.existsSync(path.join(bundleRoot, 'runtime', 'bundle-backups')), 'off-mode update git must stop before bundle sync starts');
        } finally {
            removePathRecursive(projectRoot);
        }
    });

    it('allows update git check-only while Garda is off', async () => {
        const { projectRoot, bundleRoot } = setupSyncedUpdateWorkspace(repoRoot);
        try {
            const sourceBundleRoot = path.join(projectRoot, 'update-source');
            copyDirRecursive(bundleRoot, sourceBundleRoot);
            fs.writeFileSync(path.join(sourceBundleRoot, 'VERSION'), '9.9.9\n', 'utf8');
            seedGitRepository(sourceBundleRoot);
            seedOffModeState(bundleRoot);

            const result = await runUpdateFromGit({
                targetRoot: projectRoot,
                bundleRoot,
                repoUrl: sourceBundleRoot,
                checkOnly: true,
                trustOverride: true,
                updateRunner() {
                    throw new Error('updateRunner should not execute for update git check-only');
                }
            });

            assert.equal(result.updateApplied, false);
            assert.equal(result.checkUpdateResult, 'UPDATE_AVAILABLE');
            assert.equal(result.updateAvailable, true);
            assert.ok(!fs.existsSync(path.join(bundleRoot, 'runtime', 'bundle-backups')), 'check-only off-mode update git must not sync bundle items');
        } finally {
            removePathRecursive(projectRoot);
        }
    });

    it('blocks update apply before bundle sync when agent-init project commands are pending', async () => {
        const { projectRoot, bundleRoot } = setupSyncedUpdateWorkspace(repoRoot);
        try {
            seedPrimaryInitializedWorkspace(projectRoot, bundleRoot, {
                compileGateCommand: UNCONFIGURED_COMPILE_GATE_COMMAND,
                agentInitComplete: true
            });
            const originalReadme = fs.readFileSync(path.join(bundleRoot, 'README.md'), 'utf8');
            const sourceBundleRoot = path.join(projectRoot, 'update-source');
            copyDirRecursive(bundleRoot, sourceBundleRoot);
            fs.writeFileSync(path.join(sourceBundleRoot, 'README.md'), `${originalReadme}\nupdated before agent init\n`, 'utf8');

            let updateRunnerCalled = false;
            await assert.rejects(() => runCheckUpdate({
                targetRoot: projectRoot,
                bundleRoot,
                sourcePath: sourceBundleRoot,
                diagnosticTool: 'git',
                apply: true,
                noPrompt: true,
                trustOverride: true,
                updateRunner() {
                    updateRunnerCalled = true;
                }
            }), /GARDA_UPDATE_AGENT_INIT_REQUIRED[\s\S]*PROJECT_COMMANDS_PENDING[\s\S]*MissingProjectCommands: [^\n]*compile_gate\.command[\s\S]*agent-init --target-root[\s\S]*workflow set[\s\S]*--target-root/);

            assert.equal(updateRunnerCalled, false, 'updateRunner must not execute before agent-init readiness');
            assert.equal(fs.readFileSync(path.join(bundleRoot, 'README.md'), 'utf8'), originalReadme);
            assert.ok(!fs.existsSync(path.join(bundleRoot, 'runtime', 'bundle-backups')), 'blocked update must stop before bundle sync backup');
        } finally {
            removePathRecursive(projectRoot);
        }
    });

    it('blocks update apply before bundle sync after fresh setup before agent handoff', async () => {
        const { projectRoot, bundleRoot } = setupSyncedUpdateWorkspace(repoRoot);
        try {
            seedPrimaryInitializedWorkspaceWithoutAgentInitState(projectRoot, bundleRoot);
            const originalReadme = fs.readFileSync(path.join(bundleRoot, 'README.md'), 'utf8');
            const sourceBundleRoot = path.join(projectRoot, 'update-source');
            copyDirRecursive(bundleRoot, sourceBundleRoot);
            fs.writeFileSync(path.join(sourceBundleRoot, 'README.md'), `${originalReadme}\nfresh setup update\n`, 'utf8');

            let updateRunnerCalled = false;
            await assert.rejects(() => runCheckUpdate({
                targetRoot: projectRoot,
                bundleRoot,
                sourcePath: sourceBundleRoot,
                diagnosticTool: 'git',
                apply: true,
                noPrompt: true,
                trustOverride: true,
                updateRunner() {
                    updateRunnerCalled = true;
                }
            }), /GARDA_UPDATE_AGENT_INIT_REQUIRED[\s\S]*AGENT_HANDOFF_REQUIRED[\s\S]*AGENT_INIT_PROMPT\.md[\s\S]*agent-init --target-root/);

            assert.equal(updateRunnerCalled, false, 'updateRunner must not execute before fresh setup agent handoff');
            assert.equal(fs.readFileSync(path.join(bundleRoot, 'README.md'), 'utf8'), originalReadme);
            assert.ok(!fs.existsSync(path.join(bundleRoot, 'runtime', 'bundle-backups')), 'fresh setup block must stop before bundle sync backup');
            assert.ok(!fs.existsSync(path.join(bundleRoot, 'runtime', 'update-rollbacks')), 'fresh setup block must stop before rollback snapshots');
        } finally {
            removePathRecursive(projectRoot);
        }
    });

    it('keeps rollback and protected-manifest recovery artifacts untouched when readiness blocks update apply', async () => {
        const { projectRoot, bundleRoot } = setupSyncedUpdateWorkspace(repoRoot);
        try {
            seedPrimaryInitializedWorkspace(projectRoot, bundleRoot, {
                compileGateCommand: UNCONFIGURED_COMPILE_GATE_COMMAND,
                agentInitComplete: true
            });
            const manifestPath = path.join(bundleRoot, 'runtime', 'protected-control-plane-manifest.json');
            const manifestPayload = JSON.stringify({ marker: 'preserve-before-readiness-block' }, null, 2) + '\n';
            fs.writeFileSync(manifestPath, manifestPayload, 'utf8');
            const sourceBundleRoot = path.join(projectRoot, 'update-source');
            copyDirRecursive(bundleRoot, sourceBundleRoot);
            fs.writeFileSync(path.join(sourceBundleRoot, 'README.md'), 'blocked before recovery paths\n', 'utf8');

            await assert.rejects(() => runCheckUpdate({
                targetRoot: projectRoot,
                bundleRoot,
                sourcePath: sourceBundleRoot,
                diagnosticTool: 'git',
                apply: true,
                noPrompt: true,
                trustOverride: true
            }), /Safety: update apply stopped before bundle sync; no rollback was needed/);

            assert.equal(fs.readFileSync(manifestPath, 'utf8'), manifestPayload);
            assert.ok(!fs.existsSync(path.join(bundleRoot, 'runtime', 'bundle-backups')), 'blocked update must not create sync backups');
            assert.ok(!fs.existsSync(path.join(bundleRoot, 'runtime', 'update-rollbacks')), 'blocked update must not create rollback snapshots');
            assert.ok(!fs.existsSync(getUpdateSentinelPath(bundleRoot)), 'blocked update must not write update sentinel');
        } finally {
            removePathRecursive(projectRoot);
        }
    });

    it('uses lightweight agent-init readiness for pre-apply update guards', () => {
        const syncSource = fs.readFileSync(
            path.join(repoRoot, 'src', 'lifecycle', 'check-update', 'check-update-bundle-sync.ts'),
            'utf8'
        );

        assert.match(syncSource, /getAgentInitializationReadinessSnapshot/);
        assert.doesNotMatch(syncSource, /getStatusSnapshot/);
    });

    it('keeps check-only and dry-run update readable before agent-init readiness', async () => {
        const { projectRoot, bundleRoot } = setupSyncedUpdateWorkspace(repoRoot);
        try {
            seedPrimaryInitializedWorkspace(projectRoot, bundleRoot, {
                compileGateCommand: UNCONFIGURED_COMPILE_GATE_COMMAND,
                agentInitComplete: true
            });
            const sourceBundleRoot = path.join(projectRoot, 'update-source');
            copyDirRecursive(bundleRoot, sourceBundleRoot);
            fs.writeFileSync(path.join(sourceBundleRoot, 'README.md'), 'dry run drift\n', 'utf8');

            const checkOnly = await runCheckUpdate({
                targetRoot: projectRoot,
                bundleRoot,
                sourcePath: sourceBundleRoot,
                diagnosticTool: 'git',
                apply: false,
                trustOverride: true
            });
            assert.equal(checkOnly.updateApplied, false);
            assert.equal(checkOnly.updateAvailable, true);
            assert.equal(checkOnly.checkUpdateResult, 'UPDATE_AVAILABLE');

            const dryRun = await runCheckUpdate({
                targetRoot: projectRoot,
                bundleRoot,
                sourcePath: sourceBundleRoot,
                diagnosticTool: 'git',
                apply: true,
                dryRun: true,
                trustOverride: true
            });
            assert.equal(dryRun.updateApplied, false);
            assert.equal(dryRun.checkUpdateResult, 'DRY_RUN_UPDATE_AVAILABLE');
            assert.ok(!fs.existsSync(path.join(bundleRoot, 'runtime', 'bundle-backups')), 'read-only update modes must not create bundle sync backups');
        } finally {
            removePathRecursive(projectRoot);
        }
    });

    it('allows update apply when agent-init project commands are configured', async () => {
        const { projectRoot, bundleRoot } = setupSyncedUpdateWorkspace(repoRoot);
        try {
            seedPrimaryInitializedWorkspace(projectRoot, bundleRoot, {
                compileGateCommand: 'npm run build',
                agentInitComplete: true
            });
            const sourceBundleRoot = path.join(projectRoot, 'update-source');
            copyDirRecursive(bundleRoot, sourceBundleRoot);
            fs.writeFileSync(path.join(sourceBundleRoot, 'README.md'), 'configured workspace update\n', 'utf8');

            let updateRunnerCalled = false;
            const result = await runCheckUpdate({
                targetRoot: projectRoot,
                bundleRoot,
                sourcePath: sourceBundleRoot,
                diagnosticTool: 'git',
                apply: true,
                noPrompt: true,
                trustOverride: true,
                updateRunner() {
                    updateRunnerCalled = true;
                }
            });

            assert.equal(updateRunnerCalled, true);
            assert.equal(result.updateApplied, true);
            assert.equal(result.checkUpdateResult, 'UPDATED');
            assert.equal(fs.readFileSync(path.join(bundleRoot, 'README.md'), 'utf8'), 'configured workspace update\n');
        } finally {
            removePathRecursive(projectRoot);
        }
    });

    it('does not bypass foreign-host lifecycle locks when legacy update sentinel is present', () => {
        const { projectRoot, bundleRoot, answersPath } = setupUpdateWorkspace(repoRoot);
        try {
            seedLifecycleOperationLock(projectRoot, process.pid, 'foreign-build-host');
            writeUpdateSentinel(bundleRoot, {
                startedAt: new Date().toISOString(),
                fromVersion: '0.0.1',
                toVersion: fs.readFileSync(path.join(bundleRoot, 'VERSION'), 'utf8').trim()
            });

            assert.throws(
                () => runUpdate({
                    targetRoot: projectRoot,
                    bundleRoot,
                    initAnswersPath: answersPath,
                    skipVerify: true,
                    skipManifestValidation: true
                }),
                /Another lifecycle operation is already running/
            );
        } finally {
            removePathRecursive(projectRoot);
        }
    });

    it('blocks update apply when a task-event runtime lock exists before rollback or install', () => {
        const { projectRoot, bundleRoot, answersPath } = setupUpdateWorkspace(repoRoot);
        try {
            let installRunnerCalled = false;
            seedActiveTaskEventLock(bundleRoot, '.T-ACTIVE.lock');

            assert.throws(
                () => runUpdate({
                    targetRoot: projectRoot,
                    bundleRoot,
                    initAnswersPath: answersPath,
                    skipVerify: true,
                    skipManifestValidation: true,
                    installRunner: () => {
                        installRunnerCalled = true;
                    }
                }),
                /Runtime update preflight blocked apply.*task-event:\.T-ACTIVE\.lock/
            );

            assert.equal(installRunnerCalled, false, 'installRunner must not execute while runtime locks exist');
            assert.ok(!fs.existsSync(path.join(bundleRoot, 'runtime', 'update-rollbacks')), 'update must stop before rollback snapshot creation');
        } finally {
            removePathRecursive(projectRoot);
        }
    });

    it('blocks direct update apply in off mode before rollback or install', () => {
        const { projectRoot, bundleRoot, answersPath } = setupUpdateWorkspace(repoRoot);
        try {
            let installRunnerCalled = false;
            seedOffModeState(bundleRoot);

            assert.throws(
                () => runUpdate({
                    targetRoot: projectRoot,
                    bundleRoot,
                    initAnswersPath: answersPath,
                    skipVerify: true,
                    skipManifestValidation: true,
                    installRunner: () => {
                        installRunnerCalled = true;
                    }
                }),
                /GARDA_UPDATE_OFF_MODE_BLOCKED: update apply cannot apply while Garda is off.*garda on/
            );

            assert.equal(installRunnerCalled, false, 'installRunner must not execute while Garda is off');
            assert.ok(!fs.existsSync(path.join(bundleRoot, 'runtime', 'update-rollbacks')), 'off-mode update must stop before rollback snapshot creation');
        } finally {
            removePathRecursive(projectRoot);
        }
    });

    it('blocks update apply when a stale task-event runtime lock exists', () => {
        const { projectRoot, bundleRoot, answersPath } = setupUpdateWorkspace(repoRoot);
        try {
            seedStaleTaskEventLock(bundleRoot, '.T-STALE.lock');

            assert.throws(
                () => runUpdate({
                    targetRoot: projectRoot,
                    bundleRoot,
                    initAnswersPath: answersPath,
                    skipVerify: true,
                    skipManifestValidation: true
                }),
                /Runtime update preflight blocked apply.*task-event:\.T-STALE\.lock.*status=STALE/
            );

            assert.ok(fs.existsSync(path.join(bundleRoot, 'runtime', 'task-events', '.T-STALE.lock')));
            assert.ok(!fs.existsSync(path.join(bundleRoot, 'runtime', 'update-rollbacks')), 'stale runtime locks must block before rollback snapshot creation');
        } finally {
            removePathRecursive(projectRoot);
        }
    });

    it('rolls back on install failure', () => {
        const { projectRoot, bundleRoot, answersPath } = setupUpdateWorkspace(repoRoot);
        try {
            // Create a file that should be in pre-update snapshot
            fs.writeFileSync(path.join(projectRoot, 'CLAUDE.md'), 'original-content');

            assert.throws(
                () => runUpdate({
                    targetRoot: projectRoot,
                    bundleRoot,
                    initAnswersPath: answersPath,
                    skipVerify: true,
                    skipManifestValidation: true,
                    installRunner: () => {
                        throw new Error('Simulated install failure');
                    }
                }),
                /rollback completed successfully.*Simulated install failure/
            );

            // CLAUDE.md should be restored by rollback
            assert.ok(fs.existsSync(path.join(projectRoot, 'CLAUDE.md')));
            assert.equal(fs.readFileSync(path.join(projectRoot, 'CLAUDE.md'), 'utf8'), 'original-content');
        } finally {
            removePathRecursive(projectRoot);
        }
    });

    it('throws when init answers not found', () => {
        const { projectRoot, bundleRoot } = setupUpdateWorkspace(repoRoot);
        try {
            assert.throws(
                () => runUpdate({
                    targetRoot: projectRoot,
                    bundleRoot,
                    initAnswersPath: 'nonexistent/path/answers.json'
                }),
                /Init answers artifact not found/
            );
        } finally {
            removePathRecursive(projectRoot);
        }
    });

    it('throws when bundle VERSION not found', () => {
        const { projectRoot, bundleRoot, answersPath } = setupUpdateWorkspace(repoRoot);
        try {
            fs.rmSync(path.join(bundleRoot, 'VERSION'));
            assert.throws(
                () => runUpdate({
                    targetRoot: projectRoot,
                    bundleRoot,
                    initAnswersPath: answersPath
                }),
                /Bundle version file not found/
            );
        } finally {
            removePathRecursive(projectRoot);
        }
    });

    it('reports rollback failure when both install and rollback fail', () => {
        const { projectRoot, bundleRoot, answersPath } = setupUpdateWorkspace(repoRoot);
        try {
            // Make rollback impossible by having a record pointing to non-existent snapshot
            assert.throws(
                () => runUpdate({
                    targetRoot: projectRoot,
                    bundleRoot,
                    initAnswersPath: answersPath,
                    installRunner: () => {
                        // Delete the rollback snapshot to cause rollback failure
                        const runtimeDir = path.join(projectRoot, 'garda-agent-orchestrator', 'runtime', 'update-rollbacks');
                        if (fs.existsSync(runtimeDir)) {
                            fs.rmSync(runtimeDir, { recursive: true, force: true });
                        }
                        throw new Error('Simulated install failure');
                    }
                }),
                /Rollback failed|rollback completed/
            );
        } finally {
            removePathRecursive(projectRoot);
        }
    });

    it('rolls back on materialization failure', () => {
        const { projectRoot, bundleRoot, answersPath } = setupUpdateWorkspace(repoRoot);
        try {
            // Create a file that should be in pre-update snapshot
            fs.writeFileSync(path.join(projectRoot, 'CLAUDE.md'), 'pre-update-content');

            assert.throws(
                () => runUpdate({
                    targetRoot: projectRoot,
                    bundleRoot,
                    initAnswersPath: answersPath,
                    skipVerify: true,
                    skipManifestValidation: true,
                    materializationRunner: () => {
                        throw new Error('Simulated materialization failure');
                    }
                }),
                /rollback completed successfully.*Simulated materialization failure/
            );

            // CLAUDE.md should be restored by rollback
            assert.ok(fs.existsSync(path.join(projectRoot, 'CLAUDE.md')));
            assert.equal(
                fs.readFileSync(path.join(projectRoot, 'CLAUDE.md'), 'utf8'),
                'pre-update-content'
            );
        } finally {
            removePathRecursive(projectRoot);
        }
    });

    it('does not rematerialize live/ in dry-run mode', () => {
        const { projectRoot, bundleRoot, answersPath } = setupUpdateWorkspace(repoRoot);
        try {
            // Seed stale live/ content
            const liveRuleDir = path.join(bundleRoot, 'live', 'docs', 'agent-rules');
            fs.mkdirSync(liveRuleDir, { recursive: true });
            fs.writeFileSync(path.join(liveRuleDir, '00-core.md'), 'STALE_DRY_RUN');

            const result = runUpdate({
                targetRoot: projectRoot,
                bundleRoot,
                initAnswersPath: answersPath,
                dryRun: true
            });

            assert.equal(result.materializationStatus, 'SKIPPED_DRY_RUN');

            // Stale content should remain since it's a dry run
            const coreRuleContent = fs.readFileSync(path.join(liveRuleDir, '00-core.md'), 'utf8');
            assert.equal(coreRuleContent, 'STALE_DRY_RUN', 'Dry run should not modify live/ content');
        } finally {
            removePathRecursive(projectRoot);
        }
    });

});

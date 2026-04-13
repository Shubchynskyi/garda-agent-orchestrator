import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import { runUninstall, parseBooleanAnswer, getUninstallRollbackItems } from '../../../src/lifecycle/uninstall';
import { removePathRecursive } from '../../../src/lifecycle/common';
import { MANAGED_START, MANAGED_END, COMMIT_GUARD_START, COMMIT_GUARD_END } from '../../../src/materialization/content-builders';

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

function setupDeployedWorkspace(repoRoot: string) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-uninstall-'));
    const bundle = path.join(tmpDir, 'garda-agent-orchestrator');
    fs.mkdirSync(bundle, { recursive: true });

    // Copy VERSION
    fs.copyFileSync(path.join(repoRoot, 'VERSION'), path.join(bundle, 'VERSION'));

    // Copy template
    const templateSrc = path.join(repoRoot, 'template');
    copyDirRecursive(templateSrc, path.join(bundle, 'template'));

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
        EnforceNoAutoCommit: 'true',
        ClaudeOrchestratorFullAccess: 'false',
        TokenEconomyEnabled: 'true',
        CollectedVia: 'CLI_NONINTERACTIVE'
    };
    fs.writeFileSync(path.join(bundle, 'runtime', 'init-answers.json'), JSON.stringify(answers, null, 2));

    // Create managed entrypoint files
    const managedContent = `${MANAGED_START}\n# Garda Agent Orchestrator Rule Index\n## Rule Routing\nSome content\n${MANAGED_END}\n`;
    fs.writeFileSync(path.join(tmpDir, 'CLAUDE.md'), managedContent);
    fs.writeFileSync(path.join(tmpDir, 'TASK.md'), managedContent);

    // Create .git dir
    fs.mkdirSync(path.join(tmpDir, '.git', 'hooks'), { recursive: true });

    // Create .gitignore with managed block
    const gitignoreContent = 'node_modules/\n# garda-agent-orchestrator managed ignores\ngarda-agent-orchestrator/\nAGENTS.md\n';
    fs.writeFileSync(path.join(tmpDir, '.gitignore'), gitignoreContent);

    return { projectRoot: tmpDir, bundleRoot: bundle };
}

describe('parseBooleanAnswer', () => {
    it('parses yes/no strings', () => {
        assert.equal(parseBooleanAnswer('yes', 'test'), true);
        assert.equal(parseBooleanAnswer('no', 'test'), false);
        assert.equal(parseBooleanAnswer('true', 'test'), true);
        assert.equal(parseBooleanAnswer('false', 'test'), false);
        assert.equal(parseBooleanAnswer('1', 'test'), true);
        assert.equal(parseBooleanAnswer('0', 'test'), false);
        assert.equal(parseBooleanAnswer('да', 'test'), true);
        assert.equal(parseBooleanAnswer('нет', 'test'), false);
    });

    it('parses native booleans', () => {
        assert.equal(parseBooleanAnswer(true, 'test'), true);
        assert.equal(parseBooleanAnswer(false, 'test'), false);
    });

    it('throws for invalid values', () => {
        assert.throws(() => parseBooleanAnswer('maybe', 'test'), /must be one of/);
    });
});

describe('runUninstall', () => {
    const repoRoot = findRepoRoot();

    it('removes deployed orchestrator files', () => {
        const { projectRoot, bundleRoot } = setupDeployedWorkspace(repoRoot);
        try {
            const result = runUninstall({
                targetRoot: projectRoot,
                bundleRoot,
                noPrompt: true,
                keepPrimaryEntrypoint: 'no',
                keepTaskFile: 'no',
                keepRuntimeArtifacts: 'no'
            });

            assert.equal(result.result, 'SUCCESS');
            assert.ok(!fs.existsSync(path.join(projectRoot, 'garda-agent-orchestrator')));
            assert.ok(!fs.existsSync(path.join(projectRoot, 'CLAUDE.md')));
            assert.ok(!fs.existsSync(path.join(projectRoot, 'TASK.md')));
            assert.ok(result.itemsBackedUp >= 1);
            assert.ok(!fs.existsSync(path.join(result.backupRoot, 'garda-agent-orchestrator')));
        } finally {
            removePathRecursive(projectRoot);
        }
    });

    it('preserves primary entrypoint when requested', () => {
        const { projectRoot, bundleRoot } = setupDeployedWorkspace(repoRoot);
        try {
            const result = runUninstall({
                targetRoot: projectRoot,
                bundleRoot,
                noPrompt: true,
                keepPrimaryEntrypoint: 'yes',
                keepTaskFile: 'no',
                keepRuntimeArtifacts: 'no'
            });

            assert.equal(result.result, 'SUCCESS');
            assert.equal(result.keepPrimaryEntrypoint, true);
            assert.ok(fs.existsSync(path.join(projectRoot, 'CLAUDE.md')));
            assert.ok(!fs.existsSync(path.join(projectRoot, 'TASK.md')));
        } finally {
            removePathRecursive(projectRoot);
        }
    });

    it('preserves TASK.md when requested', () => {
        const { projectRoot, bundleRoot } = setupDeployedWorkspace(repoRoot);
        try {
            const result = runUninstall({
                targetRoot: projectRoot,
                bundleRoot,
                noPrompt: true,
                keepPrimaryEntrypoint: 'no',
                keepTaskFile: 'yes',
                keepRuntimeArtifacts: 'no'
            });

            assert.equal(result.result, 'SUCCESS');
            assert.equal(result.keepTaskFile, true);
            assert.ok(fs.existsSync(path.join(projectRoot, 'TASK.md')));
        } finally {
            removePathRecursive(projectRoot);
        }
    });

    it('supports dry run without deleting files', () => {
        const { projectRoot, bundleRoot } = setupDeployedWorkspace(repoRoot);
        try {
            const result = runUninstall({
                targetRoot: projectRoot,
                bundleRoot,
                noPrompt: true,
                dryRun: true,
                keepPrimaryEntrypoint: 'no',
                keepTaskFile: 'no',
                keepRuntimeArtifacts: 'no'
            });

            assert.equal(result.result, 'DRY_RUN');
            // Files should still exist after dry run
            assert.ok(fs.existsSync(path.join(projectRoot, 'garda-agent-orchestrator')));
            assert.ok(fs.existsSync(path.join(projectRoot, 'CLAUDE.md')));
        } finally {
            removePathRecursive(projectRoot);
        }
    });

    it('removes managed content from .gitignore but preserves user content', () => {
        const { projectRoot, bundleRoot } = setupDeployedWorkspace(repoRoot);
        try {
            const result = runUninstall({
                targetRoot: projectRoot,
                bundleRoot,
                noPrompt: true,
                keepPrimaryEntrypoint: 'no',
                keepTaskFile: 'no',
                keepRuntimeArtifacts: 'no'
            });

            assert.equal(result.result, 'SUCCESS');
            assert.ok(fs.existsSync(path.join(projectRoot, '.gitignore')),
                '.gitignore must exist after uninstall (backup entries are always appended)');
            const content = fs.readFileSync(path.join(projectRoot, '.gitignore'), 'utf8');
            assert.ok(content.includes('node_modules/'),
                'User entries must be preserved');
            assert.ok(!content.includes('garda-agent-orchestrator/'),
                'Managed ignore entry must be removed');
            assert.ok(!content.includes('garda-agent-orchestrator managed ignores'),
                'Managed comment must be removed');
            assert.ok(content.includes('garda-agent-orchestrator-uninstall-backups/'),
                'Uninstall backup directory entry must be present');
            assert.ok(!content.includes('garda-agent-orchestrator-uninstall-backups/**'),
                'Redundant wildcard entry must not be present');
            assert.ok(content.includes('# Backup artifacts created by Garda Agent Orchestrator uninstall'),
                'Explanatory comment for uninstall backups must be present');
        } finally {
            removePathRecursive(projectRoot);
        }
    });

    it('removes legacy nested provider ignore entries from managed .gitignore blocks', () => {
        const { projectRoot, bundleRoot } = setupDeployedWorkspace(repoRoot);
        try {
            fs.writeFileSync(
                path.join(projectRoot, '.gitignore'),
                [
                    'node_modules/',
                    '# garda-agent-orchestrator managed ignores',
                    '.antigravity/',
                    '.antigravity/rules.md',
                    '.windsurf/',
                    '.windsurf/rules/rules.md'
                ].join('\n'),
                'utf8'
            );

            const result = runUninstall({
                targetRoot: projectRoot,
                bundleRoot,
                noPrompt: true,
                keepPrimaryEntrypoint: 'no',
                keepTaskFile: 'no',
                keepRuntimeArtifacts: 'no'
            });

            assert.equal(result.result, 'SUCCESS');
            assert.ok(fs.existsSync(path.join(projectRoot, '.gitignore')),
                '.gitignore must exist after uninstall (backup entries are always appended)');
            const content = fs.readFileSync(path.join(projectRoot, '.gitignore'), 'utf8');
            assert.ok(content.includes('node_modules/'),
                'User entries must be preserved');
            assert.ok(!content.includes('.antigravity/'),
                'Legacy managed entry must be removed');
            assert.ok(!content.includes('.antigravity/rules.md'),
                'Legacy managed entry must be removed');
            assert.ok(!content.includes('.windsurf/'),
                'Legacy managed entry must be removed');
            assert.ok(!content.includes('.windsurf/rules/rules.md'),
                'Legacy managed entry must be removed');
            assert.ok(content.includes('garda-agent-orchestrator-uninstall-backups/'),
                'Uninstall backup directory entry must be present');
            assert.ok(!content.includes('garda-agent-orchestrator-uninstall-backups/**'),
                'Redundant wildcard entry must not be present');
            assert.ok(content.includes('# Backup artifacts created by Garda Agent Orchestrator uninstall'),
                'Explanatory comment for uninstall backups must be present');
        } finally {
            removePathRecursive(projectRoot);
        }
    });

    it('creates .gitignore with only backup entries when cleanup removes all managed content and no backup exists', () => {
        const { projectRoot, bundleRoot } = setupDeployedWorkspace(repoRoot);
        try {
            // Replace .gitignore with managed-only content (no user entries)
            fs.writeFileSync(
                path.join(projectRoot, '.gitignore'),
                '# garda-agent-orchestrator managed ignores\ngarda-agent-orchestrator/\nAGENTS.md\n',
                'utf8'
            );

            const result = runUninstall({
                targetRoot: projectRoot,
                bundleRoot,
                noPrompt: true,
                keepPrimaryEntrypoint: 'no',
                keepTaskFile: 'no',
                keepRuntimeArtifacts: 'no'
            });

            assert.equal(result.result, 'SUCCESS');
            assert.ok(fs.existsSync(path.join(projectRoot, '.gitignore')),
                '.gitignore must be recreated with backup entries even when all managed content was removed');
            const content = fs.readFileSync(path.join(projectRoot, '.gitignore'), 'utf8');
            assert.ok(!content.includes('garda-agent-orchestrator/'),
                'Managed ignore entry must be removed');
            assert.ok(!content.includes('AGENTS.md'),
                'Managed ignore entry must be removed');
            assert.ok(!content.includes('garda-agent-orchestrator managed ignores'),
                'Managed comment must be removed');
            assert.ok(content.includes('garda-agent-orchestrator-uninstall-backups/'),
                'Uninstall backup directory entry must be present');
            assert.ok(!content.includes('garda-agent-orchestrator-uninstall-backups/**'),
                'Redundant wildcard entry must not be present');
            assert.ok(content.includes('# Backup artifacts created by Garda Agent Orchestrator uninstall'),
                'Explanatory comment for uninstall backups must be present');
        } finally {
            removePathRecursive(projectRoot);
        }
    });

    it('migrates legacy two-line backup gitignore to single entry with comment', () => {
        const { projectRoot, bundleRoot } = setupDeployedWorkspace(repoRoot);
        try {
            // Simulate a .gitignore left by the old uninstall (two-line format, no comment)
            fs.writeFileSync(
                path.join(projectRoot, '.gitignore'),
                'node_modules/\ngarda-agent-orchestrator-uninstall-backups/\ngarda-agent-orchestrator-uninstall-backups/**\n',
                'utf8'
            );

            const result = runUninstall({
                targetRoot: projectRoot,
                bundleRoot,
                noPrompt: true,
                keepPrimaryEntrypoint: 'no',
                keepTaskFile: 'no',
                keepRuntimeArtifacts: 'no'
            });

            assert.equal(result.result, 'SUCCESS');
            const content = fs.readFileSync(path.join(projectRoot, '.gitignore'), 'utf8');
            assert.ok(content.includes('node_modules/'),
                'User entries must be preserved');
            assert.ok(content.includes('garda-agent-orchestrator-uninstall-backups/'),
                'Uninstall backup directory entry must be present');
            assert.ok(!content.includes('garda-agent-orchestrator-uninstall-backups/**'),
                'Legacy wildcard entry must be removed during migration');
            assert.ok(content.includes('# Backup artifacts created by Garda Agent Orchestrator uninstall'),
                'Explanatory comment must be added during migration');
        } finally {
            removePathRecursive(projectRoot);
        }
    });

    it('strips managed blocks from qwen settings', () => {
        const { projectRoot, bundleRoot } = setupDeployedWorkspace(repoRoot);
        try {
            // Create qwen settings with managed entries
            fs.mkdirSync(path.join(projectRoot, '.qwen'), { recursive: true });
            fs.writeFileSync(
                path.join(projectRoot, '.qwen', 'settings.json'),
                JSON.stringify({
                    context: {
                        fileName: ['TASK.md', 'user-file.md']
                    }
                }, null, 2)
            );

            const result = runUninstall({
                targetRoot: projectRoot,
                bundleRoot,
                noPrompt: true,
                keepPrimaryEntrypoint: 'no',
                keepTaskFile: 'no',
                keepRuntimeArtifacts: 'no'
            });

            assert.equal(result.result, 'SUCCESS');
            if (fs.existsSync(path.join(projectRoot, '.qwen', 'settings.json'))) {
                const settings = JSON.parse(fs.readFileSync(path.join(projectRoot, '.qwen', 'settings.json'), 'utf8'));
                assert.ok(settings.context);
                assert.ok(settings.context.fileName.includes('user-file.md'));
                assert.ok(!settings.context.fileName.includes('TASK.md'));
            }
        } finally {
            removePathRecursive(projectRoot);
        }
    });

    it('strips managed entries from claude local settings', () => {
        const { projectRoot, bundleRoot } = setupDeployedWorkspace(repoRoot);
        try {
            fs.mkdirSync(path.join(projectRoot, '.claude'), { recursive: true });
            fs.writeFileSync(
                path.join(projectRoot, '.claude', 'settings.local.json'),
                JSON.stringify({
                    permissions: {
                        allow: [
                            'Bash(node garda-agent-orchestrator/bin/garda.js *:*)',
                            'user-custom-permission'
                        ]
                    }
                }, null, 2)
            );

            const result = runUninstall({
                targetRoot: projectRoot,
                bundleRoot,
                noPrompt: true,
                keepPrimaryEntrypoint: 'no',
                keepTaskFile: 'no',
                keepRuntimeArtifacts: 'no'
            });

            assert.equal(result.result, 'SUCCESS');
            if (fs.existsSync(path.join(projectRoot, '.claude', 'settings.local.json'))) {
                const settings = JSON.parse(fs.readFileSync(path.join(projectRoot, '.claude', 'settings.local.json'), 'utf8'));
                const allowEntries = settings.permissions && settings.permissions.allow ? settings.permissions.allow : [];
                assert.ok(allowEntries.includes('user-custom-permission'));
                assert.ok(!allowEntries.some((e: string) => e.includes('garda-agent-orchestrator')));
            }
        } finally {
            removePathRecursive(projectRoot);
        }
    });

    it('preserves runtime artifacts when requested', () => {
        const { projectRoot, bundleRoot } = setupDeployedWorkspace(repoRoot);
        try {
            // Ensure runtime has content
            fs.writeFileSync(path.join(bundleRoot, 'runtime', 'test-artifact.txt'), 'data');

            const result = runUninstall({
                targetRoot: projectRoot,
                bundleRoot,
                noPrompt: true,
                keepPrimaryEntrypoint: 'no',
                keepTaskFile: 'no',
                keepRuntimeArtifacts: 'yes'
            });

            assert.equal(result.result, 'SUCCESS');
            assert.equal(result.keepRuntimeArtifacts, true);
            assert.ok(result.preservedRuntimePath !== '<none>');
            assert.ok(fs.existsSync(path.join(result.backupRoot, 'garda-agent-orchestrator', 'runtime')));
            assert.ok(!fs.existsSync(path.join(result.backupRoot, 'garda-agent-orchestrator', 'template')));
        } finally {
            removePathRecursive(projectRoot);
        }
    });

    it('preserves project-memory alongside runtime artifacts when keepRuntimeArtifacts is yes (T-072)', () => {
        const { projectRoot, bundleRoot } = setupDeployedWorkspace(repoRoot);
        try {
            // Ensure project-memory has user content
            const pmDir = path.join(bundleRoot, 'live', 'docs', 'project-memory');
            fs.mkdirSync(pmDir, { recursive: true });
            fs.writeFileSync(path.join(pmDir, 'decisions.md'), '# Decision Log\nKeep this.');

            const result = runUninstall({
                targetRoot: projectRoot,
                bundleRoot,
                noPrompt: true,
                keepPrimaryEntrypoint: 'no',
                keepTaskFile: 'no',
                keepRuntimeArtifacts: 'yes'
            });

            assert.equal(result.result, 'SUCCESS');
            assert.ok(result.preservedProjectMemoryPath !== '<none>',
                'preservedProjectMemoryPath should be set');
            const backedUpPm = path.join(result.backupRoot, 'garda-agent-orchestrator', 'live', 'docs', 'project-memory');
            assert.ok(fs.existsSync(backedUpPm), 'project-memory should be backed up');
            assert.ok(fs.existsSync(path.join(backedUpPm, 'decisions.md')),
                'user content in project-memory should be preserved');
            assert.equal(
                fs.readFileSync(path.join(backedUpPm, 'decisions.md'), 'utf8'),
                '# Decision Log\nKeep this.'
            );
        } finally {
            removePathRecursive(projectRoot);
        }
    });

    it('does not preserve project-memory when keepRuntimeArtifacts is no (T-072)', () => {
        const { projectRoot, bundleRoot } = setupDeployedWorkspace(repoRoot);
        try {
            const pmDir = path.join(bundleRoot, 'live', 'docs', 'project-memory');
            fs.mkdirSync(pmDir, { recursive: true });
            fs.writeFileSync(path.join(pmDir, 'decisions.md'), '# Decision Log');

            const result = runUninstall({
                targetRoot: projectRoot,
                bundleRoot,
                noPrompt: true,
                keepPrimaryEntrypoint: 'no',
                keepTaskFile: 'no',
                keepRuntimeArtifacts: 'no'
            });

            assert.equal(result.result, 'SUCCESS');
            assert.equal(result.preservedProjectMemoryPath, '<none>');
        } finally {
            removePathRecursive(projectRoot);
        }
    });

    it('restores files from initialization backup when available', () => {
        const { projectRoot, bundleRoot } = setupDeployedWorkspace(repoRoot);
        try {
            // Create initialization backup with pre-existing user content
            const backupDir = path.join(bundleRoot, 'runtime', 'backups', '20250101-120000');
            fs.mkdirSync(backupDir, { recursive: true });
            fs.writeFileSync(path.join(backupDir, 'CLAUDE.md'), '# My original Claude file');
            fs.writeFileSync(
                path.join(backupDir, '_install-backup.manifest.json'),
                JSON.stringify({ PreExistingFiles: ['CLAUDE.md'] })
            );

            const result = runUninstall({
                targetRoot: projectRoot,
                bundleRoot,
                noPrompt: true,
                keepPrimaryEntrypoint: 'no',
                keepTaskFile: 'no',
                keepRuntimeArtifacts: 'no'
            });

            assert.equal(result.result, 'SUCCESS');
            assert.ok(result.filesRestored >= 1);
            // After restore, CLAUDE.md should have original content
            assert.ok(fs.existsSync(path.join(projectRoot, 'CLAUDE.md')));
            assert.equal(
                fs.readFileSync(path.join(projectRoot, 'CLAUDE.md'), 'utf8'),
                '# My original Claude file'
            );
        } finally {
            removePathRecursive(projectRoot);
        }
    });

    it('removes drifted managed entrypoints without marker warnings when signatures still match orchestrator content', () => {
        const { projectRoot, bundleRoot } = setupDeployedWorkspace(repoRoot);
        try {
            fs.writeFileSync(
                path.join(projectRoot, 'CLAUDE.md'),
                [
                    '# CLAUDE.md',
                    '',
                    '# Garda Agent Orchestrator Rule Index',
                    '',
                    '## Rule Routing',
                    'Some project-specific notes'
                ].join('\n')
            );
            fs.writeFileSync(
                path.join(projectRoot, 'AGENTS.md'),
                [
                    '# AGENTS.md',
                    '',
                    'This file is a redirect.',
                    'Canonical source of truth for agent workflow rules: `CLAUDE.md`.'
                ].join('\n')
            );

            const result = runUninstall({
                targetRoot: projectRoot,
                bundleRoot,
                noPrompt: true,
                keepPrimaryEntrypoint: 'no',
                keepTaskFile: 'no',
                keepRuntimeArtifacts: 'no'
            });

            assert.equal(result.result, 'SUCCESS');
            assert.ok(!fs.existsSync(path.join(projectRoot, 'CLAUDE.md')));
            assert.ok(!fs.existsSync(path.join(projectRoot, 'AGENTS.md')));
            assert.ok(!result.warnings.some((warning) => warning.includes("CLAUDE.md")));
            assert.ok(!result.warnings.some((warning) => warning.includes("AGENTS.md")));
        } finally {
            removePathRecursive(projectRoot);
        }
    });

    it('supports skip-backups flag', () => {
        const { projectRoot, bundleRoot } = setupDeployedWorkspace(repoRoot);
        try {
            const result = runUninstall({
                targetRoot: projectRoot,
                bundleRoot,
                noPrompt: true,
                skipBackups: true,
                keepPrimaryEntrypoint: 'no',
                keepTaskFile: 'no',
                keepRuntimeArtifacts: 'no'
            });

            assert.equal(result.result, 'SUCCESS');
            assert.equal(result.skipBackups, true);
            assert.equal(result.backupRoot, '<none>');
        } finally {
            removePathRecursive(projectRoot);
        }
    });

    it('cleans up commit guard hook', () => {
        const { projectRoot, bundleRoot } = setupDeployedWorkspace(repoRoot);
        try {
            const hookPath = path.join(projectRoot, '.git', 'hooks', 'pre-commit');
            const hookContent = [
                '#!/usr/bin/env bash',
                '# User hook',
                'echo "user hook"',
                COMMIT_GUARD_START,
                'echo "guard"',
                COMMIT_GUARD_END
            ].join('\n');
            fs.writeFileSync(hookPath, hookContent);

            const result = runUninstall({
                targetRoot: projectRoot,
                bundleRoot,
                noPrompt: true,
                keepPrimaryEntrypoint: 'no',
                keepTaskFile: 'no',
                keepRuntimeArtifacts: 'no'
            });

            assert.equal(result.result, 'SUCCESS');
            if (fs.existsSync(hookPath)) {
                const content = fs.readFileSync(hookPath, 'utf8');
                assert.ok(!content.includes(COMMIT_GUARD_START));
                assert.ok(content.includes('user hook'));
            }
        } finally {
            removePathRecursive(projectRoot);
        }
    });

    // -----------------------------------------------------------------------
    // T-091: Preserve LF line endings when cleaning commit guard hook
    // -----------------------------------------------------------------------

    it('preserves LF line endings in hook after managed block removal', () => {
        const { projectRoot, bundleRoot } = setupDeployedWorkspace(repoRoot);
        try {
            const hookPath = path.join(projectRoot, '.git', 'hooks', 'pre-commit');
            // Build hook content with pure LF endings (as install writes it)
            const hookContent =
                '#!/usr/bin/env bash\n' +
                '\n' +
                '# User lint check\n' +
                'npm run lint\n' +
                '\n' +
                COMMIT_GUARD_START + '\n' +
                'echo "guard"\n' +
                COMMIT_GUARD_END + '\n';
            fs.writeFileSync(hookPath, hookContent, 'utf8');

            const result = runUninstall({
                targetRoot: projectRoot,
                bundleRoot,
                noPrompt: true,
                keepPrimaryEntrypoint: 'no',
                keepTaskFile: 'no',
                keepRuntimeArtifacts: 'no'
            });

            assert.equal(result.result, 'SUCCESS');
            assert.ok(fs.existsSync(hookPath), 'Hook file should still exist (user content remains)');

            const remaining = fs.readFileSync(hookPath, 'utf8');
            assert.ok(!remaining.includes(COMMIT_GUARD_START), 'Managed block should be removed');
            assert.ok(remaining.includes('npm run lint'), 'User hook content should be preserved');
            assert.ok(!remaining.includes('\r\n'), 'File must not contain CRLF — bash hooks require LF');
            assert.ok(remaining.includes('\n'), 'File should contain LF line endings');
        } finally {
            removePathRecursive(projectRoot);
        }
    });

    // -----------------------------------------------------------------------
    // T-069: Journal / transaction-like uninstall tests
    // -----------------------------------------------------------------------

    it('reports rollbackStatus as NOT_TRIGGERED on success', () => {
        const { projectRoot, bundleRoot } = setupDeployedWorkspace(repoRoot);
        try {
            const result = runUninstall({
                targetRoot: projectRoot,
                bundleRoot,
                noPrompt: true,
                keepPrimaryEntrypoint: 'no',
                keepTaskFile: 'no',
                keepRuntimeArtifacts: 'no'
            });

            assert.equal(result.result, 'SUCCESS');
            assert.equal(result.rollbackStatus, 'NOT_TRIGGERED');
        } finally {
            removePathRecursive(projectRoot);
        }
    });

    it('rolls back workspace on mid-flight failure', () => {
        const { projectRoot, bundleRoot } = setupDeployedWorkspace(repoRoot);
        try {
            const claudeContentBefore = fs.readFileSync(path.join(projectRoot, 'CLAUDE.md'), 'utf8');
            const taskContentBefore = fs.readFileSync(path.join(projectRoot, 'TASK.md'), 'utf8');
            const gitignoreContentBefore = fs.readFileSync(path.join(projectRoot, '.gitignore'), 'utf8');

            assert.throws(() => {
                runUninstall({
                    targetRoot: projectRoot,
                    bundleRoot,
                    noPrompt: true,
                    keepPrimaryEntrypoint: 'no',
                    keepTaskFile: 'no',
                    keepRuntimeArtifacts: 'no',
                    _testHooks: {
                        afterFileCleanup: () => {
                            throw new Error('Simulated mid-flight failure');
                        }
                    }
                });
            }, /restored to pre-uninstall state/);

            // All workspace files should be restored to their pre-uninstall state
            assert.ok(fs.existsSync(path.join(projectRoot, 'CLAUDE.md')));
            assert.ok(fs.existsSync(path.join(projectRoot, 'TASK.md')));
            assert.equal(
                fs.readFileSync(path.join(projectRoot, 'CLAUDE.md'), 'utf8'),
                claudeContentBefore
            );
            assert.equal(
                fs.readFileSync(path.join(projectRoot, 'TASK.md'), 'utf8'),
                taskContentBefore
            );
            assert.equal(
                fs.readFileSync(path.join(projectRoot, '.gitignore'), 'utf8'),
                gitignoreContentBefore
            );
            // Sentinel should be cleaned up after successful rollback
            assert.ok(!fs.existsSync(path.join(projectRoot, '.uninstall-in-progress')));
            // Journal directory should be cleaned up
            assert.ok(!fs.existsSync(path.join(projectRoot, 'garda-agent-orchestrator-uninstall-journal')));
            // Bundle should still exist (failure happened before bundle removal)
            assert.ok(fs.existsSync(bundleRoot));
        } finally {
            removePathRecursive(projectRoot);
        }
    });

    it('writes sentinel during uninstall and removes it on success', () => {
        const { projectRoot, bundleRoot } = setupDeployedWorkspace(repoRoot);
        try {
            let sentinelExistedDuringRun = false;
            const result = runUninstall({
                targetRoot: projectRoot,
                bundleRoot,
                noPrompt: true,
                keepPrimaryEntrypoint: 'no',
                keepTaskFile: 'no',
                keepRuntimeArtifacts: 'no',
                _testHooks: {
                    afterFileCleanup: () => {
                        sentinelExistedDuringRun = fs.existsSync(
                            path.join(projectRoot, '.uninstall-in-progress')
                        );
                    }
                }
            });

            assert.equal(result.result, 'SUCCESS');
            assert.ok(sentinelExistedDuringRun, 'Sentinel should exist during uninstall execution');
            assert.ok(
                !fs.existsSync(path.join(projectRoot, '.uninstall-in-progress')),
                'Sentinel should be removed after success'
            );
        } finally {
            removePathRecursive(projectRoot);
        }
    });

    it('emits warnings when --skip-backups is active', () => {
        const { projectRoot, bundleRoot } = setupDeployedWorkspace(repoRoot);
        try {
            const result = runUninstall({
                targetRoot: projectRoot,
                bundleRoot,
                noPrompt: true,
                skipBackups: true,
                keepPrimaryEntrypoint: 'no',
                keepTaskFile: 'no',
                keepRuntimeArtifacts: 'no'
            });

            assert.equal(result.result, 'SUCCESS');
            assert.equal(result.skipBackups, true);
            assert.ok(
                result.warnings.some((w) => w.includes('--skip-backups active')),
                'Should warn about skip-backups being active'
            );
            assert.ok(
                result.warnings.some((w) => w.includes('runtime artifacts')),
                'Should warn about permanent runtime artifact loss'
            );
        } finally {
            removePathRecursive(projectRoot);
        }
    });

    it('skip-backups does not warn about runtime when keepRuntimeArtifacts is yes', () => {
        const { projectRoot, bundleRoot } = setupDeployedWorkspace(repoRoot);
        try {
            fs.writeFileSync(path.join(bundleRoot, 'runtime', 'test-artifact.txt'), 'data');

            const result = runUninstall({
                targetRoot: projectRoot,
                bundleRoot,
                noPrompt: true,
                skipBackups: true,
                keepPrimaryEntrypoint: 'no',
                keepTaskFile: 'no',
                keepRuntimeArtifacts: 'yes'
            });

            assert.equal(result.result, 'SUCCESS');
            assert.ok(
                result.warnings.some((w) => w.includes('--skip-backups active')),
                'Should warn about skip-backups'
            );
            assert.ok(
                !result.warnings.some((w) => w.includes('runtime artifacts')),
                'Should NOT warn about runtime when keepRuntimeArtifacts=yes'
            );
        } finally {
            removePathRecursive(projectRoot);
        }
    });

    it('detects interrupted uninstall from previous run', () => {
        const { projectRoot, bundleRoot } = setupDeployedWorkspace(repoRoot);
        try {
            // Write a fake sentinel from a "previous interrupted uninstall"
            fs.writeFileSync(
                path.join(projectRoot, '.uninstall-in-progress'),
                JSON.stringify({
                    startedAt: '2025-01-01T00:00:00.000Z',
                    operation: 'uninstall',
                    rollbackSnapshotPath: '/fake/path'
                })
            );

            const result = runUninstall({
                targetRoot: projectRoot,
                bundleRoot,
                noPrompt: true,
                keepPrimaryEntrypoint: 'no',
                keepTaskFile: 'no',
                keepRuntimeArtifacts: 'no'
            });

            assert.equal(result.result, 'SUCCESS');
            assert.ok(
                result.warnings.some((w) => w.includes('Detected interrupted uninstall')),
                'Should warn about interrupted previous uninstall'
            );
            // Sentinel should be removed after successful completion
            assert.ok(!fs.existsSync(path.join(projectRoot, '.uninstall-in-progress')));
        } finally {
            removePathRecursive(projectRoot);
        }
    });

    it('rollback still works with --skip-backups', () => {
        const { projectRoot, bundleRoot } = setupDeployedWorkspace(repoRoot);
        try {
            const claudeContentBefore = fs.readFileSync(path.join(projectRoot, 'CLAUDE.md'), 'utf8');

            assert.throws(() => {
                runUninstall({
                    targetRoot: projectRoot,
                    bundleRoot,
                    noPrompt: true,
                    skipBackups: true,
                    keepPrimaryEntrypoint: 'no',
                    keepTaskFile: 'no',
                    keepRuntimeArtifacts: 'no',
                    _testHooks: {
                        afterFileCleanup: () => {
                            throw new Error('Simulated failure');
                        }
                    }
                });
            }, /restored to pre-uninstall state/);

            // Workspace should be restored even with --skip-backups
            assert.ok(fs.existsSync(path.join(projectRoot, 'CLAUDE.md')));
            assert.equal(
                fs.readFileSync(path.join(projectRoot, 'CLAUDE.md'), 'utf8'),
                claudeContentBefore
            );
            // Journal should be cleaned up after successful rollback
            assert.ok(!fs.existsSync(path.join(projectRoot, '.uninstall-in-progress')));
            assert.ok(!fs.existsSync(path.join(projectRoot, 'garda-agent-orchestrator-uninstall-journal')));
        } finally {
            removePathRecursive(projectRoot);
        }
    });

    it('getUninstallRollbackItems returns expected item set', () => {
        const items = getUninstallRollbackItems();
        assert.ok(Array.isArray(items));
        assert.ok(items.includes('TASK.md'));
        assert.ok(items.includes('.gitignore'));
        assert.ok(items.includes('.qwen/settings.json'));
        assert.ok(items.includes('.claude/settings.local.json'));
        assert.ok(items.includes('.git/hooks/pre-commit'));
        // Should include entrypoint files
        assert.ok(items.some((i) => i === 'CLAUDE.md' || i === 'AGENTS.md'));
        // Should include provider agent files
        assert.ok(items.some((i) => i.includes('.github/agents/orchestrator.md')));
        // Should include skill bridge files
        assert.ok(items.some((i) => i.includes('.github/agents/reviewer.md')));
        // Should include shared start-task router
        assert.ok(items.some((i) => i.includes('.agents/workflows/start-task.md')),
            'Rollback items must include the shared start-task router');
    });

    it('dry-run does not create journal or sentinel', () => {
        const { projectRoot, bundleRoot } = setupDeployedWorkspace(repoRoot);
        try {
            const result = runUninstall({
                targetRoot: projectRoot,
                bundleRoot,
                noPrompt: true,
                dryRun: true,
                keepPrimaryEntrypoint: 'no',
                keepTaskFile: 'no',
                keepRuntimeArtifacts: 'no'
            });

            assert.equal(result.result, 'DRY_RUN');
            assert.equal(result.rollbackStatus, 'NOT_NEEDED');
            assert.ok(!fs.existsSync(path.join(projectRoot, '.uninstall-in-progress')));
            assert.ok(!fs.existsSync(path.join(projectRoot, 'garda-agent-orchestrator-uninstall-journal')));
        } finally {
            removePathRecursive(projectRoot);
        }
    });
});

// ---------------------------------------------------------------------------
// Uninstall ownership boundary hardening (T-013)
// ---------------------------------------------------------------------------

describe('uninstall ownership boundaries (T-013)', () => {
    const repoRoot = findRepoRoot();

    it('rejects init answers path that escapes target root', () => {
        const { projectRoot, bundleRoot } = setupDeployedWorkspace(repoRoot);
        try {
            const outsideAnswers = path.resolve(projectRoot, '..', 'evil-answers.json');
            assert.throws(
                () => runUninstall({
                    targetRoot: projectRoot,
                    bundleRoot,
                    initAnswersPath: outsideAnswers,
                    noPrompt: true,
                    keepPrimaryEntrypoint: 'no',
                    keepTaskFile: 'no',
                    keepRuntimeArtifacts: 'no'
                }),
                /resolves outside permitted root/
            );
        } finally {
            removePathRecursive(projectRoot);
        }
    });

    it('rejects relative init answers path with traversal', () => {
        const { projectRoot, bundleRoot } = setupDeployedWorkspace(repoRoot);
        try {
            assert.throws(
                () => runUninstall({
                    targetRoot: projectRoot,
                    bundleRoot,
                    initAnswersPath: '../../escape/answers.json',
                    noPrompt: true,
                    keepPrimaryEntrypoint: 'no',
                    keepTaskFile: 'no',
                    keepRuntimeArtifacts: 'no'
                }),
                /resolves outside permitted root/
            );
        } finally {
            removePathRecursive(projectRoot);
        }
    });
});

// ---------------------------------------------------------------------------
// Uninstall dry-run preview enrichment (T-013)
// ---------------------------------------------------------------------------

describe('uninstall dry-run preview (T-013)', () => {
    const repoRoot = findRepoRoot();

    it('dry-run returns previewAffectedFiles with specific paths', () => {
        const { projectRoot, bundleRoot } = setupDeployedWorkspace(repoRoot);
        try {
            const result = runUninstall({
                targetRoot: projectRoot,
                bundleRoot,
                noPrompt: true,
                dryRun: true,
                keepPrimaryEntrypoint: 'no',
                keepTaskFile: 'no',
                keepRuntimeArtifacts: 'no'
            });

            assert.equal(result.result, 'DRY_RUN');
            const preview = result.previewAffectedFiles;
            assert.ok(Array.isArray(preview), 'previewAffectedFiles must be an array');
            assert.ok(preview.length > 0, 'dry-run preview must list affected paths');
            assert.ok(
                preview.some(f => f === 'garda-agent-orchestrator/'),
                'preview must include bundle directory'
            );
        } finally {
            removePathRecursive(projectRoot);
        }
    });

    it('non-dry-run returns empty previewAffectedFiles', () => {
        const { projectRoot, bundleRoot } = setupDeployedWorkspace(repoRoot);
        try {
            const result = runUninstall({
                targetRoot: projectRoot,
                bundleRoot,
                noPrompt: true,
                keepPrimaryEntrypoint: 'no',
                keepTaskFile: 'no',
                keepRuntimeArtifacts: 'no'
            });

            assert.equal(result.result, 'SUCCESS');
            const preview = result.previewAffectedFiles;
            assert.ok(Array.isArray(preview), 'previewAffectedFiles must be an array');
            assert.equal(preview.length, 0, 'non-dry-run must return empty preview');
        } finally {
            removePathRecursive(projectRoot);
        }
    });
});

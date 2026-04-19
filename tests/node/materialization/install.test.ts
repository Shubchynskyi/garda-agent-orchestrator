import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import { runInstall } from '../../../src/materialization/install';
import { getLifecycleOperationLockPath } from '../../../src/lifecycle/common';
import {
    getLegacyUninstallBackupGitignoreEntry,
    UNINSTALL_BACKUP_GITIGNORE_COMMENT,
    getUninstallBackupGitignoreEntry
} from '../../../src/materialization/content-builders';

type CapturedInitRunnerOptions = {
    claudeOrchestratorFullAccess?: boolean;
    providerMinimalism?: boolean;
    activeAgentFilesSeed?: string | null;
};

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

function setupTestWorkspace(bundleRoot: string) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-install-'));

    // Create a mock bundle inside the project root
    const bundle = path.join(tmpDir, 'garda-agent-orchestrator');
    fs.mkdirSync(bundle, { recursive: true });

    // Copy VERSION
    fs.copyFileSync(path.join(bundleRoot, 'VERSION'), path.join(bundle, 'VERSION'));

    // Copy template directory (minimal subset)
    const templateSrc = path.join(bundleRoot, 'template');
    const templateDst = path.join(bundle, 'template');
    copyDirRecursive(templateSrc, templateDst);

    // Create runtime dir for init answers
    const runtimeDir = path.join(bundle, 'runtime');
    fs.mkdirSync(runtimeDir, { recursive: true });

    // Create live dir
    fs.mkdirSync(path.join(bundle, 'live'), { recursive: true });

    // Create .git so commit guard tests pass
    fs.mkdirSync(path.join(tmpDir, '.git', 'hooks'), { recursive: true });

    return { projectRoot: tmpDir, bundleRoot: bundle };
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

function writeInitAnswers(bundleRoot: string, answers: Record<string, unknown>) {
    const answersPath = path.join(bundleRoot, 'runtime', 'init-answers.json');
    fs.mkdirSync(path.dirname(answersPath), { recursive: true });
    fs.writeFileSync(answersPath, JSON.stringify(answers, null, 2));
    return answersPath;
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
    }, null, 2));
    return lockPath;
}

describe('runInstall', () => {
    const repoRoot = findRepoRoot();

    it('deploys TASK.md and creates entrypoint files', () => {
        const { projectRoot, bundleRoot } = setupTestWorkspace(repoRoot);
        try {
            const answersPath = writeInitAnswers(bundleRoot, {
                AssistantLanguage: 'English',
                AssistantBrevity: 'concise',
                SourceOfTruth: 'Claude',
                EnforceNoAutoCommit: 'false',
                ClaudeOrchestratorFullAccess: 'false',
                TokenEconomyEnabled: 'true',
                CollectedVia: 'CLI_NONINTERACTIVE'
            });

            const result = runInstall({
                targetRoot: projectRoot,
                bundleRoot,
                runInit: false,
                assistantLanguage: 'English',
                assistantBrevity: 'concise',
                sourceOfTruth: 'Claude',
                initAnswersPath: answersPath
            });

            assert.ok(result.filesDeployed >= 1);
            assert.ok(fs.existsSync(path.join(projectRoot, 'TASK.md')));
            assert.ok(fs.existsSync(path.join(projectRoot, 'CLAUDE.md')));
            assert.ok(result.liveVersionWritten);
            assert.ok(result.protectedControlPlaneManifestWritten);
            assert.ok(fs.existsSync(path.join(bundleRoot, 'live', 'version.json')));
            assert.ok(fs.existsSync(path.join(bundleRoot, 'runtime', 'protected-control-plane-manifest.json')));
            assert.equal(result.canonicalEntrypoint, 'CLAUDE.md');
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });

    it('creates redirect entrypoint for active agent files', () => {
        const { projectRoot, bundleRoot } = setupTestWorkspace(repoRoot);
        try {
            const answersPath = writeInitAnswers(bundleRoot, {
                AssistantLanguage: 'English',
                AssistantBrevity: 'concise',
                SourceOfTruth: 'Claude',
                EnforceNoAutoCommit: 'false',
                ClaudeOrchestratorFullAccess: 'false',
                TokenEconomyEnabled: 'true',
                CollectedVia: 'CLI_NONINTERACTIVE',
                ActiveAgentFiles: 'CLAUDE.md, AGENTS.md'
            });

            const result = runInstall({
                targetRoot: projectRoot,
                bundleRoot,
                runInit: false,
                assistantLanguage: 'English',
                assistantBrevity: 'concise',
                sourceOfTruth: 'Claude',
                initAnswersPath: answersPath
            });

            assert.ok(fs.existsSync(path.join(projectRoot, 'AGENTS.md')));
            const agentsContent = fs.readFileSync(path.join(projectRoot, 'AGENTS.md'), 'utf8');
            assert.ok(agentsContent.includes('redirect'));
            assert.ok(agentsContent.includes('CLAUDE.md'));
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });

    it('does not create .qwen/settings.json when qwen is not already configured', () => {
        const { projectRoot, bundleRoot } = setupTestWorkspace(repoRoot);
        try {
            const answersPath = writeInitAnswers(bundleRoot, {
                AssistantLanguage: 'English',
                AssistantBrevity: 'concise',
                SourceOfTruth: 'Claude',
                EnforceNoAutoCommit: 'false',
                ClaudeOrchestratorFullAccess: 'false',
                TokenEconomyEnabled: 'true',
                CollectedVia: 'CLI_NONINTERACTIVE'
            });

            runInstall({
                targetRoot: projectRoot,
                bundleRoot,
                runInit: false,
                assistantLanguage: 'English',
                assistantBrevity: 'concise',
                sourceOfTruth: 'Claude',
                initAnswersPath: answersPath
            });

            assert.ok(!fs.existsSync(path.join(projectRoot, '.qwen', 'settings.json')));
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });

    it('fails when another live lifecycle operation lock exists', () => {
        const { projectRoot, bundleRoot } = setupTestWorkspace(repoRoot);
        try {
            const answersPath = writeInitAnswers(bundleRoot, {
                AssistantLanguage: 'English',
                AssistantBrevity: 'concise',
                SourceOfTruth: 'Claude',
                EnforceNoAutoCommit: 'false',
                ClaudeOrchestratorFullAccess: 'false',
                TokenEconomyEnabled: 'true',
                CollectedVia: 'CLI_NONINTERACTIVE'
            });
            const lockPath = seedLifecycleOperationLock(projectRoot, process.pid);

            assert.throws(() => runInstall({
                targetRoot: projectRoot,
                bundleRoot,
                runInit: false,
                assistantLanguage: 'English',
                assistantBrevity: 'concise',
                sourceOfTruth: 'Claude',
                initAnswersPath: answersPath
            }), /Another lifecycle operation is already running/);
            assert.ok(fs.existsSync(lockPath), 'live lock must be preserved');
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });

    it('reclaims stale lifecycle operation locks before install', () => {
        const { projectRoot, bundleRoot } = setupTestWorkspace(repoRoot);
        try {
            const answersPath = writeInitAnswers(bundleRoot, {
                AssistantLanguage: 'English',
                AssistantBrevity: 'concise',
                SourceOfTruth: 'Claude',
                EnforceNoAutoCommit: 'false',
                ClaudeOrchestratorFullAccess: 'false',
                TokenEconomyEnabled: 'true',
                CollectedVia: 'CLI_NONINTERACTIVE'
            });
            const lockPath = seedLifecycleOperationLock(projectRoot, 99999999);

            const result = runInstall({
                targetRoot: projectRoot,
                bundleRoot,
                runInit: false,
                assistantLanguage: 'English',
                assistantBrevity: 'concise',
                sourceOfTruth: 'Claude',
                initAnswersPath: answersPath
            });

            assert.ok(result.liveVersionWritten);
            assert.ok(!fs.existsSync(lockPath), 'stale lock should be removed after successful install');
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });

    it('updates existing .qwen/settings.json in place', () => {
        const { projectRoot, bundleRoot } = setupTestWorkspace(repoRoot);
        try {
            const answersPath = writeInitAnswers(bundleRoot, {
                AssistantLanguage: 'English',
                AssistantBrevity: 'concise',
                SourceOfTruth: 'Claude',
                EnforceNoAutoCommit: 'false',
                ClaudeOrchestratorFullAccess: 'false',
                TokenEconomyEnabled: 'true',
                CollectedVia: 'CLI_NONINTERACTIVE'
            });

            fs.mkdirSync(path.join(projectRoot, '.qwen'), { recursive: true });
            fs.writeFileSync(
                path.join(projectRoot, '.qwen', 'settings.json'),
                JSON.stringify({ context: { fileName: ['README.md'] } }, null, 2)
            );

            runInstall({
                targetRoot: projectRoot,
                bundleRoot,
                runInit: false,
                assistantLanguage: 'English',
                assistantBrevity: 'concise',
                sourceOfTruth: 'Claude',
                initAnswersPath: answersPath
            });

            const settings = JSON.parse(fs.readFileSync(path.join(projectRoot, '.qwen', 'settings.json'), 'utf8'));
            assert.ok(settings.context.fileName.includes('README.md'));
            assert.ok(settings.context.fileName.includes('TASK.md'));
            assert.ok(settings.context.fileName.includes('CLAUDE.md'));
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });

    it('supports Qwen as canonical source-of-truth and keeps QWEN.md in qwen context', () => {
        const { projectRoot, bundleRoot } = setupTestWorkspace(repoRoot);
        try {
            const answersPath = writeInitAnswers(bundleRoot, {
                AssistantLanguage: 'English',
                AssistantBrevity: 'concise',
                SourceOfTruth: 'Qwen',
                EnforceNoAutoCommit: 'false',
                ClaudeOrchestratorFullAccess: 'false',
                TokenEconomyEnabled: 'true',
                CollectedVia: 'CLI_NONINTERACTIVE',
                ActiveAgentFiles: 'QWEN.md, AGENTS.md'
            });

            fs.mkdirSync(path.join(projectRoot, '.qwen'), { recursive: true });
            fs.writeFileSync(
                path.join(projectRoot, '.qwen', 'settings.json'),
                JSON.stringify({ context: { fileName: ['README.md'] } }, null, 2)
            );

            const result = runInstall({
                targetRoot: projectRoot,
                bundleRoot,
                runInit: false,
                assistantLanguage: 'English',
                assistantBrevity: 'concise',
                sourceOfTruth: 'Qwen',
                initAnswersPath: answersPath
            });

            assert.equal(result.canonicalEntrypoint, 'QWEN.md');
            assert.ok(fs.existsSync(path.join(projectRoot, 'QWEN.md')));
            assert.ok(fs.existsSync(path.join(projectRoot, 'AGENTS.md')));
            const qwenEntrypoint = fs.readFileSync(path.join(projectRoot, 'QWEN.md'), 'utf8');
            assert.ok(qwenEntrypoint.includes('# QWEN.md'));
            assert.ok(qwenEntrypoint.includes('Rule Index'));
            const settings = JSON.parse(fs.readFileSync(path.join(projectRoot, '.qwen', 'settings.json'), 'utf8'));
            assert.ok(settings.context.fileName.includes('TASK.md'));
            assert.ok(settings.context.fileName.includes('QWEN.md'));
            const gitignore = fs.readFileSync(path.join(projectRoot, '.gitignore'), 'utf8');
            assert.ok(gitignore.includes('QWEN.md'));
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });

    it('updates .gitignore', () => {
        const { projectRoot, bundleRoot } = setupTestWorkspace(repoRoot);
        try {
            const answersPath = writeInitAnswers(bundleRoot, {
                AssistantLanguage: 'English',
                AssistantBrevity: 'concise',
                SourceOfTruth: 'Claude',
                EnforceNoAutoCommit: 'false',
                ClaudeOrchestratorFullAccess: 'false',
                TokenEconomyEnabled: 'true',
                ProviderMinimalism: 'false',
                CollectedVia: 'CLI_NONINTERACTIVE'
            });

            const result = runInstall({
                targetRoot: projectRoot,
                bundleRoot,
                runInit: false,
                assistantLanguage: 'English',
                assistantBrevity: 'concise',
                sourceOfTruth: 'Claude',
                initAnswersPath: answersPath
            });

            assert.ok(result.gitignoreEntriesAdded > 0);
            const gitignore = fs.readFileSync(path.join(projectRoot, '.gitignore'), 'utf8');
            assert.ok(gitignore.includes('garda-agent-orchestrator/'));
            assert.ok(gitignore.includes('TASK.md'));
            assert.ok(gitignore.includes('AGENTS.md'));
            assert.ok(gitignore.includes('GEMINI.md'));
            assert.ok(gitignore.includes('.antigravity/'));
            assert.ok(gitignore.includes('.windsurf/'));
            assert.ok(gitignore.includes('.junie/'));
            assert.ok(!gitignore.includes('.antigravity/rules.md'));
            assert.ok(!gitignore.includes('.windsurf/rules/rules.md'));
            assert.ok(!gitignore.includes('.junie/guidelines.md'));
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });

    it('replaces an existing managed .gitignore block instead of appending a second header', () => {
        const { projectRoot, bundleRoot } = setupTestWorkspace(repoRoot);
        try {
            const answersPath = writeInitAnswers(bundleRoot, {
                AssistantLanguage: 'English',
                AssistantBrevity: 'concise',
                SourceOfTruth: 'Claude',
                EnforceNoAutoCommit: 'false',
                ClaudeOrchestratorFullAccess: 'false',
                TokenEconomyEnabled: 'true',
                ProviderMinimalism: 'false',
                CollectedVia: 'CLI_NONINTERACTIVE'
            });

            fs.writeFileSync(
                path.join(projectRoot, '.gitignore'),
                [
                    'node_modules/',
                    '# garda-agent-orchestrator managed ignores',
                    'AGENTS.md',
                    'TASK.md',
                    '.antigravity/rules.md'
                ].join('\n'),
                'utf8'
            );

            runInstall({
                targetRoot: projectRoot,
                bundleRoot,
                runInit: false,
                assistantLanguage: 'English',
                assistantBrevity: 'concise',
                sourceOfTruth: 'Claude',
                initAnswersPath: answersPath
            });

            const gitignore = fs.readFileSync(path.join(projectRoot, '.gitignore'), 'utf8');
            assert.equal((gitignore.match(/# garda-agent-orchestrator managed ignores/g) || []).length, 1);
            assert.ok(gitignore.includes('node_modules/'));
            assert.ok(gitignore.includes('.antigravity/'));
            assert.ok(!gitignore.includes('.antigravity/rules.md'));
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });

    it('migrates legacy uninstall backup .gitignore entries during install', () => {
        const { projectRoot, bundleRoot } = setupTestWorkspace(repoRoot);
        try {
            const answersPath = writeInitAnswers(bundleRoot, {
                AssistantLanguage: 'English',
                AssistantBrevity: 'concise',
                SourceOfTruth: 'Claude',
                EnforceNoAutoCommit: 'false',
                ClaudeOrchestratorFullAccess: 'false',
                TokenEconomyEnabled: 'true',
                CollectedVia: 'CLI_NONINTERACTIVE'
            });

            fs.writeFileSync(
                path.join(projectRoot, '.gitignore'),
                [
                    'node_modules/',
                    getUninstallBackupGitignoreEntry(),
                    getLegacyUninstallBackupGitignoreEntry(),
                    '# garda-agent-orchestrator managed ignores',
                    'TASK.md'
                ].join('\n'),
                'utf8'
            );

            runInstall({
                targetRoot: projectRoot,
                bundleRoot,
                runInit: false,
                assistantLanguage: 'English',
                assistantBrevity: 'concise',
                sourceOfTruth: 'Claude',
                initAnswersPath: answersPath
            });

            const gitignore = fs.readFileSync(path.join(projectRoot, '.gitignore'), 'utf8');
            const lines = gitignore.split(/\r?\n/);
            assert.equal(lines.filter((line) => line === UNINSTALL_BACKUP_GITIGNORE_COMMENT).length, 1);
            assert.equal(lines.filter((line) => line === getUninstallBackupGitignoreEntry()).length, 1);
            assert.equal(lines.includes(getLegacyUninstallBackupGitignoreEntry()), false);
            assert.equal((gitignore.match(/# garda-agent-orchestrator managed ignores/g) || []).length, 1);
            assert.ok(lines.indexOf(getUninstallBackupGitignoreEntry()) < lines.indexOf('# garda-agent-orchestrator managed ignores'));
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });

    it('writes live/version.json with correct metadata', () => {
        const { projectRoot, bundleRoot } = setupTestWorkspace(repoRoot);
        try {
            const answersPath = writeInitAnswers(bundleRoot, {
                AssistantLanguage: 'Russian',
                AssistantBrevity: 'detailed',
                SourceOfTruth: 'Codex',
                EnforceNoAutoCommit: 'false',
                ClaudeOrchestratorFullAccess: 'false',
                TokenEconomyEnabled: 'false',
                CollectedVia: 'CLI_NONINTERACTIVE'
            });

            runInstall({
                targetRoot: projectRoot,
                bundleRoot,
                runInit: false,
                assistantLanguage: 'Russian',
                assistantBrevity: 'detailed',
                sourceOfTruth: 'Codex',
                initAnswersPath: answersPath
            });

            const version = JSON.parse(fs.readFileSync(path.join(bundleRoot, 'live', 'version.json'), 'utf8'));
            assert.equal(version.SourceOfTruth, 'Codex');
            assert.equal(version.CanonicalEntrypoint, 'AGENTS.md');
            assert.equal(version.AssistantLanguage, 'Russian');
            assert.equal(version.AssistantBrevity, 'detailed');
            assert.equal(version.TokenEconomyEnabled, false);
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });

    it('throws when parameter mismatch with init answers', () => {
        const { projectRoot, bundleRoot } = setupTestWorkspace(repoRoot);
        try {
            const answersPath = writeInitAnswers(bundleRoot, {
                AssistantLanguage: 'English',
                AssistantBrevity: 'concise',
                SourceOfTruth: 'Claude',
                EnforceNoAutoCommit: 'false',
                ClaudeOrchestratorFullAccess: 'false',
                TokenEconomyEnabled: 'true',
                CollectedVia: 'CLI_NONINTERACTIVE'
            });

            assert.throws(() => runInstall({
                targetRoot: projectRoot,
                bundleRoot,
                runInit: false,
                assistantLanguage: 'Russian',
                assistantBrevity: 'concise',
                sourceOfTruth: 'Claude',
                initAnswersPath: answersPath
            }), /does not match/);
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });

    it('answer-dependent mode only syncs TASK.md managed block', () => {
        const { projectRoot, bundleRoot } = setupTestWorkspace(repoRoot);
        try {
            // First do a full install
            const answersPath = writeInitAnswers(bundleRoot, {
                AssistantLanguage: 'English',
                AssistantBrevity: 'concise',
                SourceOfTruth: 'Claude',
                EnforceNoAutoCommit: 'false',
                ClaudeOrchestratorFullAccess: 'false',
                TokenEconomyEnabled: 'true',
                CollectedVia: 'CLI_NONINTERACTIVE'
            });

            runInstall({
                targetRoot: projectRoot,
                bundleRoot,
                runInit: false,
                assistantLanguage: 'English',
                assistantBrevity: 'concise',
                sourceOfTruth: 'Claude',
                initAnswersPath: answersPath
            });

            // Now run answer-dependent mode
            const result = runInstall({
                targetRoot: projectRoot,
                bundleRoot,
                runInit: false,
                answerDependentOnly: true,
                skipBackups: true,
                assistantLanguage: 'English',
                assistantBrevity: 'concise',
                sourceOfTruth: 'Claude',
                initAnswersPath: answersPath
            });

            assert.ok(result.answerDependentOnly);
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });

    it('migrates legacy TASK.md Depth column during install sync (T-065)', () => {
        const { projectRoot, bundleRoot } = setupTestWorkspace(repoRoot);
        try {
            const answersPath = writeInitAnswers(bundleRoot, {
                AssistantLanguage: 'English',
                AssistantBrevity: 'concise',
                SourceOfTruth: 'Claude',
                EnforceNoAutoCommit: 'false',
                ClaudeOrchestratorFullAccess: 'false',
                TokenEconomyEnabled: 'true',
                CollectedVia: 'CLI_NONINTERACTIVE'
            });

            fs.writeFileSync(
                path.join(projectRoot, 'TASK.md'),
                [
                    '<!-- garda-agent-orchestrator:managed-start -->',
                    '# TASK.md',
                    '',
                    'Canonical instructions entrypoint for orchestration: `CLAUDE.md`.',
                    '## Active Queue',
                    '| ID | Status | Priority | Area | Title | Owner | Updated | Depth | Notes |',
                    '|---|---|---|---|---|---|---|---|---|',
                    '| T-777 | 🟨 IN_PROGRESS | P1 | legacy | Keep migrated row | me | 2026-01-01 | 2 | preserved-note |',
                    '<!-- garda-agent-orchestrator:managed-end -->',
                    '',
                    '## User Notes',
                    'keep-this-section'
                ].join('\n'),
                'utf8'
            );

            const result = runInstall({
                targetRoot: projectRoot,
                bundleRoot,
                runInit: false,
                assistantLanguage: 'English',
                assistantBrevity: 'concise',
                sourceOfTruth: 'Claude',
                initAnswersPath: answersPath
            });

            const taskContent = fs.readFileSync(path.join(projectRoot, 'TASK.md'), 'utf8');
            assert.ok(result.filesAligned > 0, 'TASK.md should be synced in place');
            assert.ok(taskContent.includes('| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |'));
            assert.ok(!taskContent.includes('| ID | Status | Priority | Area | Title | Owner | Updated | Depth | Notes |'));
            assert.ok(taskContent.includes('| T-777 | 🟨 IN_PROGRESS | P1 | legacy | Keep migrated row | me | 2026-01-01 | default |'));
            assert.ok(taskContent.includes('requested_depth=2; preserved-note'));
            assert.ok(!taskContent.includes('| T-777 | 🟨 IN_PROGRESS | P1 | legacy | Keep migrated row | me | 2026-01-01 | 2 | preserved-note |'));
            assert.ok(taskContent.includes('## User Notes'));
            assert.ok(taskContent.includes('keep-this-section'));
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });

    it('creates commit guard hook when enforceNoAutoCommit is true', () => {
        const { projectRoot, bundleRoot } = setupTestWorkspace(repoRoot);
        try {
            const answersPath = writeInitAnswers(bundleRoot, {
                AssistantLanguage: 'English',
                AssistantBrevity: 'concise',
                SourceOfTruth: 'Claude',
                EnforceNoAutoCommit: 'true',
                ClaudeOrchestratorFullAccess: 'false',
                TokenEconomyEnabled: 'true',
                CollectedVia: 'CLI_NONINTERACTIVE'
            });

            const result = runInstall({
                targetRoot: projectRoot,
                bundleRoot,
                runInit: false,
                assistantLanguage: 'English',
                assistantBrevity: 'concise',
                sourceOfTruth: 'Claude',
                initAnswersPath: answersPath
            });

            assert.ok(result.preCommitHookUpdated);
            const hookContent = fs.readFileSync(
                path.join(projectRoot, '.git', 'hooks', 'pre-commit'), 'utf8'
            );
            assert.ok(hookContent.includes('commit-guard'));
            assert.ok(hookContent.includes('GARDA_ALLOW_COMMIT'));
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });

    it('creates provider bridges when GitHubCopilot is active', () => {
        const { projectRoot, bundleRoot } = setupTestWorkspace(repoRoot);
        try {
            const answersPath = writeInitAnswers(bundleRoot, {
                AssistantLanguage: 'English',
                AssistantBrevity: 'concise',
                SourceOfTruth: 'GitHubCopilot',
                EnforceNoAutoCommit: 'false',
                ClaudeOrchestratorFullAccess: 'false',
                TokenEconomyEnabled: 'true',
                CollectedVia: 'CLI_NONINTERACTIVE'
            });

            runInstall({
                targetRoot: projectRoot,
                bundleRoot,
                runInit: false,
                assistantLanguage: 'English',
                assistantBrevity: 'concise',
                sourceOfTruth: 'GitHubCopilot',
                initAnswersPath: answersPath
            });

            assert.ok(fs.existsSync(path.join(projectRoot, '.github', 'agents', 'orchestrator.md')));
            assert.ok(fs.existsSync(path.join(projectRoot, '.github', 'agents', 'code-review.md')));
            assert.ok(fs.existsSync(path.join(projectRoot, '.github', 'agents', 'reviewer.md')));
            const orchestratorBridge = fs.readFileSync(path.join(projectRoot, '.github', 'agents', 'orchestrator.md'), 'utf8');
            const apiBridge = fs.readFileSync(path.join(projectRoot, '.github', 'agents', 'api-review.md'), 'utf8');
            const infraBridge = fs.readFileSync(path.join(projectRoot, '.github', 'agents', 'infra-review.md'), 'utf8');
            assert.ok(orchestratorBridge.includes('dependent downstream reviewer'));
            assert.ok(orchestratorBridge.includes('upstream PASS artifact and receipt'));
            assert.ok(orchestratorBridge.includes('Parallel reviewer fan-out is allowed only between independent review types'));
            assert.ok(apiBridge.includes('api-contract-review'));
            assert.ok(infraBridge.includes('devops-k8s'));
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });

    it('creates the shared start-task router for root entrypoint providers too', () => {
        const { projectRoot, bundleRoot } = setupTestWorkspace(repoRoot);
        try {
            const answersPath = writeInitAnswers(bundleRoot, {
                AssistantLanguage: 'English',
                AssistantBrevity: 'concise',
                SourceOfTruth: 'Codex',
                EnforceNoAutoCommit: 'false',
                ClaudeOrchestratorFullAccess: 'false',
                TokenEconomyEnabled: 'true',
                CollectedVia: 'CLI_NONINTERACTIVE'
            });

            runInstall({
                targetRoot: projectRoot,
                bundleRoot,
                runInit: false,
                assistantLanguage: 'English',
                assistantBrevity: 'concise',
                sourceOfTruth: 'Codex',
                initAnswersPath: answersPath
            });

            const workflowPath = path.join(projectRoot, '.agents', 'workflows', 'start-task.md');
            const entrypointPath = path.join(projectRoot, 'AGENTS.md');
            assert.ok(fs.existsSync(workflowPath));
            const workflow = fs.readFileSync(workflowPath, 'utf8');
            const entrypoint = fs.readFileSync(entrypointPath, 'utf8');
            assert.ok(workflow.includes('shared start-task router'));
            assert.ok(workflow.includes('Do not spawn or pre-launch a dependent downstream reviewer'));
            assert.ok(workflow.includes('Parallel reviewer fan-out is allowed only between independent review types'));
            assert.ok(entrypoint.includes('.agents/workflows/start-task.md'));
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });

    it('creates Antigravity bridge checklist workflow when Antigravity is active', () => {
        const { projectRoot, bundleRoot } = setupTestWorkspace(repoRoot);
        try {
            const answersPath = writeInitAnswers(bundleRoot, {
                AssistantLanguage: 'English',
                AssistantBrevity: 'concise',
                SourceOfTruth: 'Antigravity',
                EnforceNoAutoCommit: 'false',
                ClaudeOrchestratorFullAccess: 'false',
                TokenEconomyEnabled: 'true',
                CollectedVia: 'CLI_NONINTERACTIVE'
            });

            runInstall({
                targetRoot: projectRoot,
                bundleRoot,
                runInit: false,
                assistantLanguage: 'English',
                assistantBrevity: 'concise',
                sourceOfTruth: 'Antigravity',
                initAnswersPath: answersPath
            });

            const bridgePath = path.join(projectRoot, '.antigravity', 'agents', 'orchestrator.md');
            const workflowPath = path.join(projectRoot, '.agents', 'workflows', 'start-task.md');
            assert.ok(fs.existsSync(bridgePath));
            assert.ok(fs.existsSync(workflowPath));
            const bridge = fs.readFileSync(bridgePath, 'utf8');
            const workflow = fs.readFileSync(workflowPath, 'utf8');
            assert.ok(bridge.includes('.agents/workflows/start-task.md'));
            assert.ok(bridge.includes('dependent downstream reviewer'));
            assert.ok(bridge.includes('upstream PASS artifact and receipt'));
            assert.ok(bridge.includes('Parallel reviewer fan-out is allowed only between independent review types'));
            assert.ok(bridge.includes('Do not fan out known producer-consumer validation commands as raw shell sidecars'));
            assert.ok(bridge.includes('build:node-foundation'));
            assert.ok(workflow.includes('gate enter-task-mode'));
            assert.ok(workflow.includes('gate completion-gate'));
            assert.ok(workflow.includes('Do not fan out known producer-consumer validation commands as raw shell sidecars'));
            assert.ok(workflow.includes('build:node-foundation'));
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });

    it('refreshes stale managed dependent-reviewer wording on rerun install', () => {
        const { projectRoot, bundleRoot } = setupTestWorkspace(repoRoot);
        try {
            const answersPath = writeInitAnswers(bundleRoot, {
                AssistantLanguage: 'English',
                AssistantBrevity: 'concise',
                SourceOfTruth: 'GitHubCopilot',
                EnforceNoAutoCommit: 'false',
                ClaudeOrchestratorFullAccess: 'false',
                TokenEconomyEnabled: 'true',
                CollectedVia: 'CLI_NONINTERACTIVE'
            });

            runInstall({
                targetRoot: projectRoot,
                bundleRoot,
                runInit: false,
                assistantLanguage: 'English',
                assistantBrevity: 'concise',
                sourceOfTruth: 'GitHubCopilot',
                initAnswersPath: answersPath
            });

            const bridgePath = path.join(projectRoot, '.github', 'agents', 'orchestrator.md');
            const workflowPath = path.join(projectRoot, '.agents', 'workflows', 'start-task.md');
            const staleBridge = fs.readFileSync(bridgePath, 'utf8')
                .replace(
                    'Dependency order is a launch-time contract even on delegation-capable platforms: do not launch a dependent downstream reviewer before the required upstream PASS artifact and receipt exist for the same cycle.',
                    'Treat downstream `test` review as dependency-ordered even on delegation-capable platforms; do not fan it out in parallel with required upstream non-`test` reviews.'
                )
                .replace(
                    'Parallel reviewer fan-out is allowed only between independent review types with no dependency edge for the current cycle.',
                    'Do not treat downstream reviewers as speculative sidecars.'
                )
                .replace(
                    'Do not fan out known producer-consumer validation commands as raw shell sidecars around the gate flow. Flows such as `npm run build:node-foundation` -> direct `node --test .node-build/...` must use the guarded workflow path or run strictly sequentially, never in parallel.',
                    'Treat generated-artifact validation as best-effort shell fan-out and let local runners coordinate freshness opportunistically.'
                );
            const staleWorkflow = fs.readFileSync(workflowPath, 'utf8')
                .replace(
                    '- Do not spawn or pre-launch a dependent downstream reviewer before the required upstream PASS artifact and receipt exist for the same cycle.',
                    '- Do not spawn downstream `test` reviewers before upstream code review finishes.'
                )
                .replace(
                    '- Parallel reviewer fan-out is allowed only between independent review types with no dependency edge.',
                    '- Do not parallelize dependent reviews.'
                )
                .replace(
                    '- Do not fan out known producer-consumer validation commands as raw shell sidecars. Flows such as `npm run build:node-foundation` -> direct `node --test .node-build/...` must use the guarded workflow path or run strictly sequentially, never in parallel.',
                    '- Treat generated-artifact validation fan-out as acceptable when it is only local shell coordination.'
                );
            assert.notEqual(staleBridge, fs.readFileSync(bridgePath, 'utf8'));
            assert.ok(staleBridge.includes('Treat downstream `test` review as dependency-ordered even on delegation-capable platforms'));
            assert.ok(staleBridge.includes('Do not treat downstream reviewers as speculative sidecars.'));
            assert.ok(!staleBridge.includes('Parallel reviewer fan-out is allowed only between independent review types'));
            assert.ok(staleBridge.includes('Treat generated-artifact validation as best-effort shell fan-out'));
            assert.notEqual(staleWorkflow, fs.readFileSync(workflowPath, 'utf8'));
            assert.ok(staleWorkflow.includes('Do not spawn downstream `test` reviewers before upstream code review finishes.'));
            assert.ok(staleWorkflow.includes('Do not parallelize dependent reviews.'));
            assert.ok(!staleWorkflow.includes('Parallel reviewer fan-out is allowed only between independent review types'));
            assert.ok(staleWorkflow.includes('Treat generated-artifact validation fan-out as acceptable'));
            fs.writeFileSync(bridgePath, staleBridge, 'utf8');
            fs.writeFileSync(workflowPath, staleWorkflow, 'utf8');

            runInstall({
                targetRoot: projectRoot,
                bundleRoot,
                runInit: false,
                assistantLanguage: 'English',
                assistantBrevity: 'concise',
                sourceOfTruth: 'GitHubCopilot',
                initAnswersPath: answersPath
            });

            const refreshedBridge = fs.readFileSync(bridgePath, 'utf8');
            const refreshedWorkflow = fs.readFileSync(workflowPath, 'utf8');
            assert.ok(refreshedBridge.includes('dependent downstream reviewer'));
            assert.ok(refreshedBridge.includes('upstream PASS artifact and receipt'));
            assert.ok(refreshedBridge.includes('Parallel reviewer fan-out is allowed only between independent review types'));
            assert.ok(refreshedBridge.includes('Do not fan out known producer-consumer validation commands as raw shell sidecars'));
            assert.ok(refreshedBridge.includes('build:node-foundation'));
            assert.ok(refreshedWorkflow.includes('Do not spawn or pre-launch a dependent downstream reviewer'));
            assert.ok(refreshedWorkflow.includes('Parallel reviewer fan-out is allowed only between independent review types'));
            assert.ok(refreshedWorkflow.includes('Do not fan out known producer-consumer validation commands as raw shell sidecars'));
            assert.ok(refreshedWorkflow.includes('build:node-foundation'));
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });

    it('backs up and fully replaces conflicting legacy entrypoint files', () => {
        const { projectRoot, bundleRoot } = setupTestWorkspace(repoRoot);
        try {
            const legacyEntrypointPath = path.join(projectRoot, 'AGENTS.md');
            fs.writeFileSync(
                legacyEntrypointPath,
                '# Legacy agent instructions\n\nDo not overwrite this file in place.\n',
                'utf8'
            );

            const answersPath = writeInitAnswers(bundleRoot, {
                AssistantLanguage: 'English',
                AssistantBrevity: 'concise',
                SourceOfTruth: 'Codex',
                EnforceNoAutoCommit: 'false',
                ClaudeOrchestratorFullAccess: 'false',
                TokenEconomyEnabled: 'true',
                CollectedVia: 'CLI_NONINTERACTIVE'
            });

            const result = runInstall({
                targetRoot: projectRoot,
                bundleRoot,
                runInit: false,
                assistantLanguage: 'English',
                assistantBrevity: 'concise',
                sourceOfTruth: 'Codex',
                initAnswersPath: answersPath
            });

            const installedContent = fs.readFileSync(legacyEntrypointPath, 'utf8');
            assert.ok(installedContent.includes('garda-agent-orchestrator:managed-start'));
            assert.ok(!installedContent.includes('Legacy agent instructions'));

            const backupPath = path.join(result.backupRoot!, 'AGENTS.md');
            assert.ok(fs.existsSync(backupPath));
            assert.ok(fs.readFileSync(backupPath, 'utf8').includes('Legacy agent instructions'));
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });

    it('creates unique backup roots when multiple installs happen in the same timestamp window', () => {
        const { projectRoot, bundleRoot } = setupTestWorkspace(repoRoot);
        const RealDate = Date;
        const fixedNow = new RealDate('2026-03-22T12:00:00.123Z');

        class MockDate extends RealDate {
            constructor(...args: unknown[]) {
                if (args.length > 0) {
                    super(...(args as [string]));
                    return;
                }
                super(fixedNow.getTime());
            }

            static now() {
                return fixedNow.getTime();
            }

            static parse(value: string) {
                return RealDate.parse(value);
            }

            static UTC(...args: unknown[]) {
                return RealDate.UTC(...(args as [number]));
            }
        }

        try {
            const answersPath = writeInitAnswers(bundleRoot, {
                AssistantLanguage: 'English',
                AssistantBrevity: 'concise',
                SourceOfTruth: 'Codex',
                EnforceNoAutoCommit: 'false',
                ClaudeOrchestratorFullAccess: 'false',
                TokenEconomyEnabled: 'true',
                CollectedVia: 'CLI_NONINTERACTIVE'
            });

            global.Date = MockDate as unknown as DateConstructor;

            const legacyEntrypointPath = path.join(projectRoot, 'AGENTS.md');
            fs.writeFileSync(legacyEntrypointPath, '# First legacy instructions\n', 'utf8');
            const firstInstall = runInstall({
                targetRoot: projectRoot,
                bundleRoot,
                runInit: false,
                assistantLanguage: 'English',
                assistantBrevity: 'concise',
                sourceOfTruth: 'Codex',
                initAnswersPath: answersPath
            });

            fs.writeFileSync(legacyEntrypointPath, '# Second legacy instructions\n', 'utf8');
            const secondInstall = runInstall({
                targetRoot: projectRoot,
                bundleRoot,
                runInit: false,
                assistantLanguage: 'English',
                assistantBrevity: 'concise',
                sourceOfTruth: 'Codex',
                initAnswersPath: answersPath
            });

            assert.notEqual(firstInstall.backupRoot, secondInstall.backupRoot);
            assert.ok(fs.readFileSync(path.join(firstInstall.backupRoot!, 'AGENTS.md'), 'utf8').includes('First legacy instructions'));
            assert.ok(fs.readFileSync(path.join(secondInstall.backupRoot!, 'AGENTS.md'), 'utf8').includes('Second legacy instructions'));
        } finally {
            global.Date = RealDate;
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });

    it('dry-run does not write any files to disk', () => {
        const { projectRoot, bundleRoot } = setupTestWorkspace(repoRoot);
        try {
            const answersPath = writeInitAnswers(bundleRoot, {
                AssistantLanguage: 'English',
                AssistantBrevity: 'concise',
                SourceOfTruth: 'Claude',
                EnforceNoAutoCommit: 'false',
                ClaudeOrchestratorFullAccess: 'false',
                TokenEconomyEnabled: 'true',
                CollectedVia: 'CLI_NONINTERACTIVE'
            });

            const result = runInstall({
                targetRoot: projectRoot,
                bundleRoot,
                runInit: false,
                assistantLanguage: 'English',
                assistantBrevity: 'concise',
                sourceOfTruth: 'Claude',
                initAnswersPath: answersPath,
                dryRun: true
            });

            // filesDeployed counts what *would* be deployed; actual writes are suppressed
            assert.ok(result.filesDeployed >= 0);
            assert.equal(result.initInvoked, false);
            assert.equal(result.liveVersionWritten, false);
            assert.equal(result.backupRoot, null);
            assert.ok(!fs.existsSync(path.join(projectRoot, 'TASK.md')));
            assert.ok(!fs.existsSync(path.join(projectRoot, 'CLAUDE.md')));
            assert.ok(!fs.existsSync(path.join(bundleRoot, 'live', 'version.json')));
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });

    it('dry-run with existing bundle does not mutate bundle contents', () => {
        const { projectRoot, bundleRoot } = setupTestWorkspace(repoRoot);
        try {
            const answersPath = writeInitAnswers(bundleRoot, {
                AssistantLanguage: 'English',
                AssistantBrevity: 'concise',
                SourceOfTruth: 'Claude',
                EnforceNoAutoCommit: 'false',
                ClaudeOrchestratorFullAccess: 'false',
                TokenEconomyEnabled: 'true',
                CollectedVia: 'CLI_NONINTERACTIVE'
            });

            // First, do a real install to populate the project
            runInstall({
                targetRoot: projectRoot,
                bundleRoot,
                runInit: false,
                assistantLanguage: 'English',
                assistantBrevity: 'concise',
                sourceOfTruth: 'Claude',
                initAnswersPath: answersPath
            });

            // Snapshot the bundle directory to detect mutations
            const snapshotDir = (dir: string) => {
                const result: Record<string, { size: number; mtime: number }> = {};
                for (const entry of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
                    const full = path.join(entry.parentPath || dir, entry.name);
                    const rel = path.relative(dir, full);
                    if (entry.isFile()) {
                        const stat = fs.statSync(full);
                        result[rel] = { size: stat.size, mtime: stat.mtimeMs };
                    }
                }
                return result;
            };

            const bundleSnapshotBefore = snapshotDir(bundleRoot);
            const projectSnapshotBefore = snapshotDir(projectRoot);

            // Now run install again with dry-run
            const dryResult = runInstall({
                targetRoot: projectRoot,
                bundleRoot,
                runInit: false,
                assistantLanguage: 'English',
                assistantBrevity: 'concise',
                sourceOfTruth: 'Claude',
                initAnswersPath: answersPath,
                dryRun: true
            });

            const bundleSnapshotAfter = snapshotDir(bundleRoot);
            const projectSnapshotAfter = snapshotDir(projectRoot);

            // Verify no files were changed in the bundle
            assert.deepStrictEqual(
                Object.keys(bundleSnapshotBefore).sort(),
                Object.keys(bundleSnapshotAfter).sort(),
                'Bundle file list must not change during dry-run'
            );

            // Verify no files were changed in the project
            assert.deepStrictEqual(
                Object.keys(projectSnapshotBefore).sort(),
                Object.keys(projectSnapshotAfter).sort(),
                'Project file list must not change during dry-run'
            );

            assert.equal(dryResult.filesDeployed, 0);
            assert.equal(dryResult.backupRoot, null);
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });

    // T-1009: preserve user-retained entrypoints on update
    it('preserves pre-existing extra root entrypoints when ActiveAgentFiles is narrower (T-1009)', () => {
        const { projectRoot, bundleRoot } = setupTestWorkspace(repoRoot);
        try {
            // First install with wide ActiveAgentFiles
            const answersPath = writeInitAnswers(bundleRoot, {
                AssistantLanguage: 'English',
                AssistantBrevity: 'concise',
                SourceOfTruth: 'Claude',
                EnforceNoAutoCommit: 'false',
                ClaudeOrchestratorFullAccess: 'false',
                TokenEconomyEnabled: 'true',
                CollectedVia: 'CLI_NONINTERACTIVE',
                ActiveAgentFiles: 'CLAUDE.md, AGENTS.md, GEMINI.md'
            });

            runInstall({
                targetRoot: projectRoot,
                bundleRoot,
                runInit: false,
                assistantLanguage: 'English',
                assistantBrevity: 'concise',
                sourceOfTruth: 'Claude',
                initAnswersPath: answersPath
            });

            assert.ok(fs.existsSync(path.join(projectRoot, 'GEMINI.md')), 'GEMINI.md should exist after first install');

            // Second install with narrower ActiveAgentFiles (GEMINI.md dropped)
            const answersPath2 = writeInitAnswers(bundleRoot, {
                AssistantLanguage: 'English',
                AssistantBrevity: 'concise',
                SourceOfTruth: 'Claude',
                EnforceNoAutoCommit: 'false',
                ClaudeOrchestratorFullAccess: 'false',
                TokenEconomyEnabled: 'true',
                ProviderMinimalism: 'false',
                CollectedVia: 'CLI_NONINTERACTIVE',
                ActiveAgentFiles: 'CLAUDE.md, AGENTS.md'
            });

            const result = runInstall({
                targetRoot: projectRoot,
                bundleRoot,
                preserveExisting: true,
                alignExisting: true,
                runInit: false,
                assistantLanguage: 'English',
                assistantBrevity: 'concise',
                sourceOfTruth: 'Claude',
                initAnswersPath: answersPath2
            });

            assert.ok(fs.existsSync(path.join(projectRoot, 'GEMINI.md')),
                'GEMINI.md must be preserved after update with narrower ActiveAgentFiles');
            assert.equal(result.filesPreserved, 1, 'filesPreserved should count exactly 1 for GEMINI.md');
            const geminiContent = fs.readFileSync(path.join(projectRoot, 'GEMINI.md'), 'utf8');
            assert.ok(geminiContent.includes('CLAUDE.md'),
                'Preserved GEMINI.md should redirect to canonical CLAUDE.md');
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });

    it('preserves pre-existing provider bridge files across update (T-1009)', () => {
        const { projectRoot, bundleRoot } = setupTestWorkspace(repoRoot);
        try {
            // First install with GitHub Copilot active
            const answersPath = writeInitAnswers(bundleRoot, {
                AssistantLanguage: 'English',
                AssistantBrevity: 'concise',
                SourceOfTruth: 'GitHubCopilot',
                EnforceNoAutoCommit: 'false',
                ClaudeOrchestratorFullAccess: 'false',
                TokenEconomyEnabled: 'true',
                CollectedVia: 'CLI_NONINTERACTIVE',
                ActiveAgentFiles: '.github/copilot-instructions.md, CLAUDE.md'
            });

            runInstall({
                targetRoot: projectRoot,
                bundleRoot,
                runInit: false,
                assistantLanguage: 'English',
                assistantBrevity: 'concise',
                sourceOfTruth: 'GitHubCopilot',
                initAnswersPath: answersPath
            });

            const bridgePath = path.join(projectRoot, '.github', 'agents', 'orchestrator.md');
            const codeReviewBridgePath = path.join(projectRoot, '.github', 'agents', 'code-review.md');
            assert.ok(fs.existsSync(bridgePath), 'GitHub orchestrator bridge should exist after first install');
            assert.ok(fs.existsSync(codeReviewBridgePath), 'code-review bridge should exist after first install');

            // Second install without GitHub Copilot in ActiveAgentFiles
            const answersPath2 = writeInitAnswers(bundleRoot, {
                AssistantLanguage: 'English',
                AssistantBrevity: 'concise',
                SourceOfTruth: 'Claude',
                EnforceNoAutoCommit: 'false',
                ClaudeOrchestratorFullAccess: 'false',
                TokenEconomyEnabled: 'true',
                ProviderMinimalism: 'false',
                CollectedVia: 'CLI_NONINTERACTIVE',
                ActiveAgentFiles: 'CLAUDE.md, AGENTS.md'
            });

            const result = runInstall({
                targetRoot: projectRoot,
                bundleRoot,
                preserveExisting: true,
                alignExisting: true,
                runInit: false,
                assistantLanguage: 'English',
                assistantBrevity: 'concise',
                sourceOfTruth: 'Claude',
                initAnswersPath: answersPath2
            });

            assert.ok(fs.existsSync(path.join(projectRoot, '.github', 'copilot-instructions.md')),
                'copilot-instructions.md must be preserved');
            assert.ok(fs.existsSync(bridgePath),
                'GitHub orchestrator bridge must be preserved');
            assert.ok(fs.existsSync(codeReviewBridgePath),
                'code-review skill bridge must be preserved');
            assert.ok(result.filesPreserved >= 12,
                'filesPreserved should count copilot-instructions.md + orchestrator bridge + skill bridges');

            // Verify preserved files are re-synced to the new canonical entrypoint
            const copilotContent = fs.readFileSync(path.join(projectRoot, '.github', 'copilot-instructions.md'), 'utf8');
            assert.ok(copilotContent.includes('CLAUDE.md'),
                'Preserved copilot-instructions.md should redirect to new canonical CLAUDE.md');
            const bridgeContent = fs.readFileSync(bridgePath, 'utf8');
            assert.ok(bridgeContent.includes('CLAUDE.md'),
                'Preserved orchestrator bridge should reference new canonical CLAUDE.md');
            const codeReviewContent = fs.readFileSync(codeReviewBridgePath, 'utf8');
            assert.ok(codeReviewContent.includes('code-review'),
                'Preserved code-review bridge should retain skill content');
            assert.ok(codeReviewContent.includes('CLAUDE.md'),
                'Preserved code-review bridge should reference new canonical CLAUDE.md');
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });

    it('removes inactive managed provider files when ProviderMinimalism is enabled (T-061)', () => {
        const { projectRoot, bundleRoot } = setupTestWorkspace(repoRoot);
        try {
            const answersPath = writeInitAnswers(bundleRoot, {
                AssistantLanguage: 'English',
                AssistantBrevity: 'concise',
                SourceOfTruth: 'GitHubCopilot',
                EnforceNoAutoCommit: 'false',
                ClaudeOrchestratorFullAccess: 'false',
                TokenEconomyEnabled: 'true',
                CollectedVia: 'CLI_NONINTERACTIVE',
                ActiveAgentFiles: '.github/copilot-instructions.md, CLAUDE.md'
            });

            runInstall({
                targetRoot: projectRoot,
                bundleRoot,
                runInit: false,
                assistantLanguage: 'English',
                assistantBrevity: 'concise',
                sourceOfTruth: 'GitHubCopilot',
                initAnswersPath: answersPath
            });

            assert.ok(fs.existsSync(path.join(projectRoot, '.github', 'copilot-instructions.md')));
            assert.ok(fs.existsSync(path.join(projectRoot, '.github', 'agents', 'orchestrator.md')));
            assert.ok(fs.existsSync(path.join(projectRoot, '.github', 'agents', 'code-review.md')));

            const answersPath2 = writeInitAnswers(bundleRoot, {
                AssistantLanguage: 'English',
                AssistantBrevity: 'concise',
                SourceOfTruth: 'Claude',
                EnforceNoAutoCommit: 'false',
                ClaudeOrchestratorFullAccess: 'false',
                TokenEconomyEnabled: 'true',
                CollectedVia: 'CLI_NONINTERACTIVE',
                ActiveAgentFiles: 'CLAUDE.md'
            });

            const result = runInstall({
                targetRoot: projectRoot,
                bundleRoot,
                preserveExisting: true,
                alignExisting: true,
                runInit: false,
                assistantLanguage: 'English',
                assistantBrevity: 'concise',
                sourceOfTruth: 'Claude',
                initAnswersPath: answersPath2
            });

            assert.equal(result.filesPreserved, 0, 'provider minimalism should not preserve inactive providers');
            assert.ok(!fs.existsSync(path.join(projectRoot, '.github', 'copilot-instructions.md')));
            assert.ok(!fs.existsSync(path.join(projectRoot, '.github', 'agents', 'orchestrator.md')));
            assert.ok(!fs.existsSync(path.join(projectRoot, '.github', 'agents', 'code-review.md')));
            const gitignore = fs.readFileSync(path.join(projectRoot, '.gitignore'), 'utf8');
            assert.ok(!gitignore.includes('.github/copilot-instructions.md'));
            assert.ok(!gitignore.includes('.github/agents/'));
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });

    it('does not create new files for entrypoints that never existed on disk (T-1009)', () => {
        const { projectRoot, bundleRoot } = setupTestWorkspace(repoRoot);
        try {
            const answersPath = writeInitAnswers(bundleRoot, {
                AssistantLanguage: 'English',
                AssistantBrevity: 'concise',
                SourceOfTruth: 'Claude',
                EnforceNoAutoCommit: 'false',
                ClaudeOrchestratorFullAccess: 'false',
                TokenEconomyEnabled: 'true',
                CollectedVia: 'CLI_NONINTERACTIVE',
                ActiveAgentFiles: 'CLAUDE.md'
            });

            runInstall({
                targetRoot: projectRoot,
                bundleRoot,
                runInit: false,
                assistantLanguage: 'English',
                assistantBrevity: 'concise',
                sourceOfTruth: 'Claude',
                initAnswersPath: answersPath
            });

            // Files that were never in ActiveAgentFiles and never on disk should not exist
            assert.ok(!fs.existsSync(path.join(projectRoot, 'GEMINI.md')),
                'GEMINI.md should not be created when never in ActiveAgentFiles');
            assert.ok(!fs.existsSync(path.join(projectRoot, 'QWEN.md')),
                'QWEN.md should not be created when never in ActiveAgentFiles');
            assert.ok(!fs.existsSync(path.join(projectRoot, '.github', 'agents', 'orchestrator.md')),
                'GitHub bridge should not be created when Copilot was never active');
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });

    it('preserves extra entrypoints across reinit-style update with preserveExisting (T-1009)', () => {
        const { projectRoot, bundleRoot } = setupTestWorkspace(repoRoot);
        try {
            // First install with multiple active files
            const answersPath = writeInitAnswers(bundleRoot, {
                AssistantLanguage: 'English',
                AssistantBrevity: 'concise',
                SourceOfTruth: 'Claude',
                EnforceNoAutoCommit: 'false',
                ClaudeOrchestratorFullAccess: 'false',
                TokenEconomyEnabled: 'true',
                CollectedVia: 'CLI_NONINTERACTIVE',
                ActiveAgentFiles: 'CLAUDE.md, AGENTS.md, QWEN.md, GEMINI.md'
            });

            runInstall({
                targetRoot: projectRoot,
                bundleRoot,
                runInit: false,
                assistantLanguage: 'English',
                assistantBrevity: 'concise',
                sourceOfTruth: 'Claude',
                initAnswersPath: answersPath
            });

            assert.ok(fs.existsSync(path.join(projectRoot, 'QWEN.md')));
            assert.ok(fs.existsSync(path.join(projectRoot, 'GEMINI.md')));

            // Reinit-style update: only CLAUDE.md active, but QWEN.md and GEMINI.md on disk
            const answersPath2 = writeInitAnswers(bundleRoot, {
                AssistantLanguage: 'English',
                AssistantBrevity: 'concise',
                SourceOfTruth: 'Claude',
                EnforceNoAutoCommit: 'false',
                ClaudeOrchestratorFullAccess: 'false',
                TokenEconomyEnabled: 'true',
                ProviderMinimalism: 'false',
                CollectedVia: 'CLI_NONINTERACTIVE',
                ActiveAgentFiles: 'CLAUDE.md'
            });

            const result = runInstall({
                targetRoot: projectRoot,
                bundleRoot,
                preserveExisting: true,
                alignExisting: true,
                runInit: false,
                assistantLanguage: 'English',
                assistantBrevity: 'concise',
                sourceOfTruth: 'Claude',
                initAnswersPath: answersPath2
            });

            assert.ok(fs.existsSync(path.join(projectRoot, 'QWEN.md')),
                'QWEN.md must survive narrower ActiveAgentFiles');
            assert.ok(fs.existsSync(path.join(projectRoot, 'GEMINI.md')),
                'GEMINI.md must survive narrower ActiveAgentFiles');
            assert.ok(fs.existsSync(path.join(projectRoot, 'AGENTS.md')),
                'AGENTS.md must survive narrower ActiveAgentFiles');
            assert.equal(result.filesPreserved, 3,
                'Should preserve exactly QWEN.md, GEMINI.md, AGENTS.md');

            // Verify preserved files are still valid redirect entrypoints
            const qwenContent = fs.readFileSync(path.join(projectRoot, 'QWEN.md'), 'utf8');
            const geminiContent = fs.readFileSync(path.join(projectRoot, 'GEMINI.md'), 'utf8');
            assert.ok(qwenContent.includes('CLAUDE.md'), 'QWEN.md should redirect to canonical');
            assert.ok(geminiContent.includes('CLAUDE.md'), 'GEMINI.md should redirect to canonical');
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });

    it('does not preserve files without managed markers (T-1009)', () => {
        const { projectRoot, bundleRoot } = setupTestWorkspace(repoRoot);
        try {
            // Create a GEMINI.md with user-owned content (no managed markers)
            fs.writeFileSync(path.join(projectRoot, 'GEMINI.md'), '# My custom Gemini config\n', 'utf8');

            const answersPath = writeInitAnswers(bundleRoot, {
                AssistantLanguage: 'English',
                AssistantBrevity: 'concise',
                SourceOfTruth: 'Claude',
                EnforceNoAutoCommit: 'false',
                ClaudeOrchestratorFullAccess: 'false',
                TokenEconomyEnabled: 'true',
                CollectedVia: 'CLI_NONINTERACTIVE',
                ActiveAgentFiles: 'CLAUDE.md'
            });

            const result = runInstall({
                targetRoot: projectRoot,
                bundleRoot,
                preserveExisting: true,
                runInit: false,
                assistantLanguage: 'English',
                assistantBrevity: 'concise',
                sourceOfTruth: 'Claude',
                initAnswersPath: answersPath
            });

            // User file without managed markers should be untouched
            assert.ok(fs.existsSync(path.join(projectRoot, 'GEMINI.md')));
            const content = fs.readFileSync(path.join(projectRoot, 'GEMINI.md'), 'utf8');
            assert.ok(content.includes('My custom Gemini config'),
                'User-owned file content should remain unchanged');
            assert.equal(result.filesPreserved, 0,
                'Files without managed markers do not count as preserved');
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });

    it('does not overwrite user-owned provider bridges without managed markers during cascaded preservation (T-1009)', () => {
        const { projectRoot, bundleRoot } = setupTestWorkspace(repoRoot);
        try {
            // First install with GitHub Copilot active (creates managed bridge files)
            const answersPath = writeInitAnswers(bundleRoot, {
                AssistantLanguage: 'English',
                AssistantBrevity: 'concise',
                SourceOfTruth: 'GitHubCopilot',
                EnforceNoAutoCommit: 'false',
                ClaudeOrchestratorFullAccess: 'false',
                TokenEconomyEnabled: 'true',
                CollectedVia: 'CLI_NONINTERACTIVE',
                ActiveAgentFiles: '.github/copilot-instructions.md, CLAUDE.md'
            });

            runInstall({
                targetRoot: projectRoot,
                bundleRoot,
                runInit: false,
                assistantLanguage: 'English',
                assistantBrevity: 'concise',
                sourceOfTruth: 'GitHubCopilot',
                initAnswersPath: answersPath
            });

            // Replace the bridge with user-owned content (no managed markers)
            const bridgePath = path.join(projectRoot, '.github', 'agents', 'orchestrator.md');
            fs.writeFileSync(bridgePath, '# My custom orchestrator agent\nUser-owned content.\n', 'utf8');

            // Second install with narrower ActiveAgentFiles
            const answersPath2 = writeInitAnswers(bundleRoot, {
                AssistantLanguage: 'English',
                AssistantBrevity: 'concise',
                SourceOfTruth: 'Claude',
                EnforceNoAutoCommit: 'false',
                ClaudeOrchestratorFullAccess: 'false',
                TokenEconomyEnabled: 'true',
                CollectedVia: 'CLI_NONINTERACTIVE',
                ActiveAgentFiles: 'CLAUDE.md'
            });

            runInstall({
                targetRoot: projectRoot,
                bundleRoot,
                preserveExisting: true,
                runInit: false,
                assistantLanguage: 'English',
                assistantBrevity: 'concise',
                sourceOfTruth: 'Claude',
                initAnswersPath: answersPath2
            });

            // User-owned bridge file should not be overwritten
            const bridgeContent = fs.readFileSync(bridgePath, 'utf8');
            assert.ok(bridgeContent.includes('My custom orchestrator agent'),
                'User-owned bridge file without managed markers must not be overwritten');
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });

    it('materializes .vscode/settings.json with IDE exclude patterns', () => {
        const { projectRoot, bundleRoot } = setupTestWorkspace(repoRoot);
        try {
            const answersPath = writeInitAnswers(bundleRoot, {
                AssistantLanguage: 'English',
                AssistantBrevity: 'concise',
                SourceOfTruth: 'Claude',
                EnforceNoAutoCommit: 'false',
                ClaudeOrchestratorFullAccess: 'false',
                TokenEconomyEnabled: 'true',
                CollectedVia: 'CLI_NONINTERACTIVE'
            });

            const result = runInstall({
                targetRoot: projectRoot,
                bundleRoot,
                runInit: false,
                assistantLanguage: 'English',
                assistantBrevity: 'concise',
                sourceOfTruth: 'Claude',
                initAnswersPath: answersPath
            });

            assert.equal(result.vscodeSettingsUpdated, true);
            const vscodePath = path.join(projectRoot, '.vscode', 'settings.json');
            assert.ok(fs.existsSync(vscodePath), '.vscode/settings.json should exist');
            const settings = JSON.parse(fs.readFileSync(vscodePath, 'utf8'));
            assert.equal(settings['files.exclude']['**/garda-agent-orchestrator'], true);
            assert.equal(settings['search.exclude']['**/dist'], true);
            assert.equal(settings['files.watcherExclude']['**/node_modules'], true);
            assert.equal(settings['files.exclude']['**/runtime'], true, 'runtime directory should be excluded');
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });

    it('merges into existing .vscode/settings.json preserving user settings', () => {
        const { projectRoot, bundleRoot } = setupTestWorkspace(repoRoot);
        try {
            const vscodePath = path.join(projectRoot, '.vscode', 'settings.json');
            fs.mkdirSync(path.dirname(vscodePath), { recursive: true });
            fs.writeFileSync(vscodePath, JSON.stringify({ 'editor.fontSize': 16 }, null, 2));

            const answersPath = writeInitAnswers(bundleRoot, {
                AssistantLanguage: 'English',
                AssistantBrevity: 'concise',
                SourceOfTruth: 'Claude',
                EnforceNoAutoCommit: 'false',
                ClaudeOrchestratorFullAccess: 'false',
                TokenEconomyEnabled: 'true',
                CollectedVia: 'CLI_NONINTERACTIVE'
            });

            runInstall({
                targetRoot: projectRoot,
                bundleRoot,
                runInit: false,
                preserveExisting: true,
                assistantLanguage: 'English',
                assistantBrevity: 'concise',
                sourceOfTruth: 'Claude',
                initAnswersPath: answersPath
            });

            const settings = JSON.parse(fs.readFileSync(vscodePath, 'utf8'));
            assert.equal(settings['editor.fontSize'], 16, 'user settings should be preserved');
            assert.equal(settings['files.exclude']['**/garda-agent-orchestrator'], true);
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });

    it('passes gitignore-scoping init inputs to initRunner when install invokes init', () => {
        const { projectRoot, bundleRoot } = setupTestWorkspace(repoRoot);
        try {
            const answersPath = writeInitAnswers(bundleRoot, {
                AssistantLanguage: 'English',
                AssistantBrevity: 'concise',
                SourceOfTruth: 'Claude',
                EnforceNoAutoCommit: 'false',
                ClaudeOrchestratorFullAccess: 'true',
                TokenEconomyEnabled: 'true',
                ProviderMinimalism: 'false',
                CollectedVia: 'CLI_NONINTERACTIVE',
                ActiveAgentFiles: 'CLAUDE.md, AGENTS.md'
            });
            let captured: CapturedInitRunnerOptions | undefined;
            let capturedCalled = false;

            runInstall({
                targetRoot: projectRoot,
                bundleRoot,
                runInit: true,
                assistantLanguage: 'English',
                assistantBrevity: 'concise',
                sourceOfTruth: 'Claude',
                initAnswersPath: answersPath,
                initRunner(options) {
                    captured = options;
                    capturedCalled = true;
                }
            });

            assert.equal(capturedCalled, true, 'initRunner should receive install-provided init options');
            const capturedOptions = captured!;
            assert.equal(capturedOptions.claudeOrchestratorFullAccess, true);
            assert.equal(capturedOptions.providerMinimalism, false);
            assert.equal(capturedOptions.activeAgentFilesSeed, 'CLAUDE.md, AGENTS.md');
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });
});

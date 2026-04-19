import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { handleInit } from '../../../../src/cli/commands/workspace-command';

function findRepoRoot(startDir: string): string {
    let current = path.resolve(startDir);
    while (current !== path.dirname(current)) {
        if (fs.existsSync(path.join(current, 'VERSION')) && fs.existsSync(path.join(current, 'template'))) {
            return current;
        }
        current = path.dirname(current);
    }
    throw new Error(`Cannot find repo root from ${startDir}`);
}

function copyDirRecursive(src: string, dst: string): void {
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

function setupWorkspace(repoRoot: string) {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-workspace-init-'));
    const bundleRoot = path.join(projectRoot, 'garda-agent-orchestrator');
    fs.mkdirSync(bundleRoot, { recursive: true });
    fs.copyFileSync(path.join(repoRoot, 'VERSION'), path.join(bundleRoot, 'VERSION'));
    copyDirRecursive(path.join(repoRoot, 'template'), path.join(bundleRoot, 'template'));
    fs.mkdirSync(path.join(bundleRoot, 'runtime'), { recursive: true });
    fs.mkdirSync(path.join(bundleRoot, 'live'), { recursive: true });
    return { projectRoot, bundleRoot };
}

test('handleInit forwards init-answer gitignore options into standalone init materialization', () => {
    const repoRoot = findRepoRoot(__dirname);
    const { projectRoot, bundleRoot } = setupWorkspace(repoRoot);
    const answersPath = path.join(bundleRoot, 'runtime', 'init-answers.json');
    fs.writeFileSync(answersPath, JSON.stringify({
        AssistantLanguage: 'English',
        AssistantBrevity: 'concise',
        SourceOfTruth: 'Claude',
        EnforceNoAutoCommit: 'false',
        ClaudeOrchestratorFullAccess: 'true',
        TokenEconomyEnabled: 'true',
        ProviderMinimalism: 'true',
        CollectedVia: 'CLI_NONINTERACTIVE',
        ActiveAgentFiles: 'CLAUDE.md, AGENTS.md'
    }, null, 2), 'utf8');

    const originalConsoleLog = console.log;
    console.log = () => undefined;
    try {
        handleInit(['--target-root', projectRoot], { name: 'garda-agent-orchestrator', version: '1.0.0' });
        const gitignore = fs.readFileSync(path.join(projectRoot, '.gitignore'), 'utf8');
        assert.ok(gitignore.includes('.review-temp/'));
        assert.ok(gitignore.includes('.claude/'));
        assert.ok(gitignore.includes('AGENTS.md'));
        assert.ok(!gitignore.includes('GEMINI.md'));
    } finally {
        console.log = originalConsoleLog;
        fs.rmSync(projectRoot, { recursive: true, force: true });
    }
});

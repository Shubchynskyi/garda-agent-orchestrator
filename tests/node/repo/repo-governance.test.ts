import test from 'node:test';
import assert from 'node:assert/strict';
import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { getRepoRoot } from '../../../scripts/node-foundation/build';
import {
    buildProviderOrchestratorAgentContent,
    buildSharedStartTaskWorkflowContent
} from '../../../src/materialization/content-builders';

function readRepoFile(relativePath: string): string {
    const repoRoot = getRepoRoot();
    const filePath = path.join(repoRoot, relativePath);
    assert.ok(fs.existsSync(filePath), `${relativePath} must exist`);
    return fs.readFileSync(filePath, 'utf8');
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

test('repo governance files use the current owner handle and root-relative paths', () => {
    const codeowners = readRepoFile('.github/CODEOWNERS');
    const branchProtection = readRepoFile('docs/branch-protection.md');
    const gitleaks = readRepoFile('.gitleaks.toml');

    assert.ok(!codeowners.includes('@anthropic-team/orchestrator-maintainers'));
    assert.match(codeowners, /@Shubchynskyi/);
    for (const pattern of [
        'runtime/',
        'garda-agent-orchestrator/runtime/',
        'live/docs/agent-rules/',
        'garda-agent-orchestrator/live/docs/agent-rules/',
        'live/config/',
        'garda-agent-orchestrator/live/config/',
        'live/skills/',
        'garda-agent-orchestrator/live/skills/',
        'src/',
        'garda-agent-orchestrator/src/',
        'bin/',
        'garda-agent-orchestrator/bin/',
        'dist/',
        'garda-agent-orchestrator/dist/',
        'template/',
        'garda-agent-orchestrator/template/'
    ]) {
        assert.match(
            codeowners,
            new RegExp(`^${escapeRegExp(pattern)}\\s+@Shubchynskyi$`, 'm'),
            `CODEOWNERS must cover ${pattern}`
        );
    }

    assert.ok(!branchProtection.includes('@anthropic-team/orchestrator-maintainers'));
    assert.match(branchProtection, /@Shubchynskyi/);
    assert.match(branchProtection, /runtime\/.*garda-agent-orchestrator\/runtime\//s);
    assert.match(branchProtection, /src\/.*garda-agent-orchestrator\/src\//s);

    assert.ok(!gitleaks.includes("'''tests/.*'''"));
    assert.ok(!gitleaks.includes("'''dist/.*'''"));
    assert.match(gitleaks, /'''runtime\/\.\*'''/);
    assert.match(gitleaks, /'''garda-agent-orchestrator\/runtime\/\.\*'''/);
    assert.ok(gitleaks.includes("'''tests/node/core/redaction\\.test\\.ts'''"));
});

test('template TASK scaffold is tracked and not ignored by root gitignore', () => {
    const repoRoot = getRepoRoot();
    const templateTaskPath = path.join(repoRoot, 'template', 'TASK.md');

    assert.ok(fs.existsSync(templateTaskPath), 'template/TASK.md must exist on disk');

    const trackedResult = childProcess.spawnSync('git', ['ls-files', '--error-unmatch', 'template/TASK.md'], {
        cwd: repoRoot,
        encoding: 'utf8',
        windowsHide: true
    });
    assert.equal(
        trackedResult.status,
        0,
        `template/TASK.md must be tracked in git.\n${trackedResult.stderr || trackedResult.stdout}`
    );

    const ignoredResult = childProcess.spawnSync('git', ['check-ignore', 'template/TASK.md'], {
        cwd: repoRoot,
        encoding: 'utf8',
        windowsHide: true
    });
    assert.notEqual(
        ignoredResult.status,
        0,
        `template/TASK.md must not be ignored by .gitignore.\n${ignoredResult.stdout || ignoredResult.stderr}`
    );
});

test('source-checkout router files stay synced with generated task-start/runtime-identity guidance', () => {
    const normalize = (content: string) => content.replace(/\r\n/g, '\n').trim();
    assert.equal(
        normalize(readRepoFile('.agents/workflows/start-task.md')),
        normalize(buildSharedStartTaskWorkflowContent('AGENTS.md'))
    );

    const providerFiles = [
        ['.github/agents/orchestrator.md', 'GitHub Copilot', '.github/agents/orchestrator.md'],
        ['.windsurf/agents/orchestrator.md', 'Windsurf', '.windsurf/agents/orchestrator.md'],
        ['.junie/agents/orchestrator.md', 'Junie', '.junie/agents/orchestrator.md'],
        ['.antigravity/agents/orchestrator.md', 'Antigravity', '.antigravity/agents/orchestrator.md']
    ] as const;
    for (const [relativePath, providerLabel, bridgePath] of providerFiles) {
        assert.equal(
            normalize(readRepoFile(relativePath)),
            normalize(buildProviderOrchestratorAgentContent(providerLabel, 'AGENTS.md', bridgePath)),
            `${relativePath} must stay synced with generated provider bridge content`
        );
    }
});

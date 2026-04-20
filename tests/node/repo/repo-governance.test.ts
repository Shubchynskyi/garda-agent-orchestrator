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

function assertRepoFileTrackedAndNotIgnored(relativePath: string): void {
    const repoRoot = getRepoRoot();
    const trackedResult = childProcess.spawnSync('git', ['ls-files', '--error-unmatch', relativePath], {
        cwd: repoRoot,
        encoding: 'utf8',
        windowsHide: true
    });
    assert.equal(
        trackedResult.status,
        0,
        `${relativePath} must be tracked in git.\n${trackedResult.stderr || trackedResult.stdout}`
    );

    const ignoredResult = childProcess.spawnSync('git', ['check-ignore', relativePath], {
        cwd: repoRoot,
        encoding: 'utf8',
        windowsHide: true
    });
    assert.notEqual(
        ignoredResult.status,
        0,
        `${relativePath} must not be ignored by .gitignore.\n${ignoredResult.stdout || ignoredResult.stderr}`
    );
}

function assertRepoFileIgnoredAndNotTracked(relativePath: string): void {
    const repoRoot = getRepoRoot();
    const trackedResult = childProcess.spawnSync('git', ['ls-files', '--error-unmatch', relativePath], {
        cwd: repoRoot,
        encoding: 'utf8',
        windowsHide: true
    });
    assert.notEqual(
        trackedResult.status,
        0,
        `${relativePath} must remain generated-only in the source checkout.\n${trackedResult.stderr || trackedResult.stdout}`
    );

    const ignoredResult = childProcess.spawnSync('git', ['check-ignore', relativePath], {
        cwd: repoRoot,
        encoding: 'utf8',
        windowsHide: true
    });
    assert.equal(
        ignoredResult.status,
        0,
        `${relativePath} must remain ignored by root .gitignore.\n${ignoredResult.stdout || ignoredResult.stderr}`
    );
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
    assertRepoFileTrackedAndNotIgnored('template/TASK.md');
});

test('source-checkout generated router files stay synced with builder output when materialized locally', () => {
    const repoRoot = getRepoRoot();
    const normalize = (content: string) => content.replace(/\r\n/g, '\n').trim();
    const generatedFiles = [
        ['.agents/workflows/start-task.md', buildSharedStartTaskWorkflowContent('AGENTS.md')],
        ['.github/agents/orchestrator.md', buildProviderOrchestratorAgentContent('GitHub Copilot', 'AGENTS.md', '.github/agents/orchestrator.md')],
        ['.windsurf/agents/orchestrator.md', buildProviderOrchestratorAgentContent('Windsurf', 'AGENTS.md', '.windsurf/agents/orchestrator.md')],
        ['.junie/agents/orchestrator.md', buildProviderOrchestratorAgentContent('Junie', 'AGENTS.md', '.junie/agents/orchestrator.md')],
        ['.antigravity/agents/orchestrator.md', buildProviderOrchestratorAgentContent('Antigravity', 'AGENTS.md', '.antigravity/agents/orchestrator.md')]
    ] as const;
    for (const [relativePath, expectedContent] of generatedFiles) {
        assertRepoFileIgnoredAndNotTracked(relativePath);
        const filePath = path.join(repoRoot, relativePath);
        if (!fs.existsSync(filePath)) {
            continue;
        }
        assert.equal(
            normalize(fs.readFileSync(filePath, 'utf8')),
            normalize(expectedContent),
            `${relativePath} must stay synced with generated content when materialized locally`
        );
    }
});

test('start-banner contract stays synced across canonical guidance files', () => {
    const startBannerToken = '--start-banner "<repo-owned-banner>"';
    const listGateText = 'list the first mandatory gates to run';
    const legacyStartMarker = 'files not modified yet';

    for (const relativePath of [
        'template/skills/orchestration/SKILL.md',
        'template/docs/agent-rules/40-commands.md',
        'template/docs/agent-rules/90-skill-catalog.md',
        'garda-agent-orchestrator/live/skills/orchestration/SKILL.md',
        'garda-agent-orchestrator/live/docs/agent-rules/40-commands.md',
        'garda-agent-orchestrator/live/docs/agent-rules/90-skill-catalog.md',
        'garda-agent-orchestrator/template/skills/orchestration/SKILL.md',
        'garda-agent-orchestrator/template/docs/agent-rules/40-commands.md',
        'garda-agent-orchestrator/template/docs/agent-rules/90-skill-catalog.md'
    ]) {
        const content = readRepoFile(relativePath);
        assert.ok(content.includes(startBannerToken), `${relativePath} must mention the repo-owned start banner flag`);
    }

    for (const relativePath of [
        'template/skills/orchestration/SKILL.md',
        'template/skills/orchestration-depth1/SKILL.md',
        'template/.agents/workflows/start-task.md',
        'garda-agent-orchestrator/template/docs/agent-rules/80-task-workflow.md',
        'garda-agent-orchestrator/live/skills/orchestration/SKILL.md',
        'garda-agent-orchestrator/live/skills/orchestration-depth1/SKILL.md',
        'garda-agent-orchestrator/template/.agents/workflows/start-task.md',
        'garda-agent-orchestrator/template/skills/orchestration/SKILL.md',
        'garda-agent-orchestrator/template/skills/orchestration-depth1/SKILL.md'
    ]) {
        const content = readRepoFile(relativePath);
        assert.ok(content.includes(listGateText), `${relativePath} must preserve the start-banner gate-list instruction`);
    }

    for (const relativePath of [
        'garda-agent-orchestrator/template/CLAUDE.md',
        'garda-agent-orchestrator/template/docs/agent-rules/80-task-workflow.md',
        'template/skills/orchestration/SKILL.md',
        'template/skills/orchestration-depth1/SKILL.md',
        'template/.agents/workflows/start-task.md',
        'garda-agent-orchestrator/live/skills/orchestration/SKILL.md',
        'garda-agent-orchestrator/live/skills/orchestration-depth1/SKILL.md',
        'garda-agent-orchestrator/template/.agents/workflows/start-task.md',
        'garda-agent-orchestrator/template/skills/orchestration/SKILL.md',
        'garda-agent-orchestrator/template/skills/orchestration-depth1/SKILL.md'
    ]) {
        const content = readRepoFile(relativePath);
        assert.ok(!content.includes(legacyStartMarker), `${relativePath} must not keep the legacy start marker`);
    }
});

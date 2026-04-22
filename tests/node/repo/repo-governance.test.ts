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

function readGeneratedRepoFile(relativePath: string): string {
    const repoRoot = getRepoRoot();
    const filePath = path.join(repoRoot, relativePath);
    assertRepoFileIgnoredAndNotTracked(relativePath);
    assert.ok(fs.existsSync(filePath), `${relativePath} must exist in the materialized repo surface`);
    return fs.readFileSync(filePath, 'utf8');
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractMarkdownSection(content: string, heading: string): string {
    const headingMatch = heading.match(/^(#+)\s+/);
    assert.ok(headingMatch, `Heading must be markdown-formatted: ${heading}`);
    const headingLevel = headingMatch[1].length;
    const startPattern = new RegExp(`^${escapeRegExp(heading)}\\s*$`, 'm');
    const startMatch = startPattern.exec(content);
    assert.ok(startMatch, `Missing heading: ${heading}`);
    const sectionStart = startMatch.index;
    const searchStart = sectionStart + startMatch[0].length;
    const remainder = content.slice(searchStart);
    const nextHeadingPattern = new RegExp(`^#{1,${headingLevel}}\\s+`, 'm');
    const nextHeadingMatch = nextHeadingPattern.exec(remainder);
    const sectionEnd = nextHeadingMatch
        ? searchStart + nextHeadingMatch.index
        : content.length;
    return content.slice(sectionStart, sectionEnd);
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

    const trackedCanonicalFiles = [
        'template/skills/orchestration/SKILL.md',
        'template/docs/agent-rules/40-commands.md',
        'template/docs/agent-rules/90-skill-catalog.md'
    ] as const;

    const materializedGeneratedFiles = [
        'garda-agent-orchestrator/live/skills/orchestration/SKILL.md',
        'garda-agent-orchestrator/live/docs/agent-rules/40-commands.md',
        'garda-agent-orchestrator/live/docs/agent-rules/90-skill-catalog.md',
        'garda-agent-orchestrator/live/skills/orchestration-depth1/SKILL.md',
        'garda-agent-orchestrator/template/.agents/workflows/start-task.md',
        'garda-agent-orchestrator/template/skills/orchestration/SKILL.md',
        'garda-agent-orchestrator/template/skills/orchestration-depth1/SKILL.md',
        'garda-agent-orchestrator/template/docs/agent-rules/40-commands.md',
        'garda-agent-orchestrator/template/docs/agent-rules/90-skill-catalog.md',
        'garda-agent-orchestrator/template/docs/agent-rules/80-task-workflow.md',
        'garda-agent-orchestrator/template/CLAUDE.md'
    ] as const;

    for (const relativePath of trackedCanonicalFiles) {
        const content = readRepoFile(relativePath);
        assert.ok(content.includes(startBannerToken), `${relativePath} must mention the repo-owned start banner flag`);
    }

    for (const relativePath of [
        'template/skills/orchestration/SKILL.md',
        'template/skills/orchestration-depth1/SKILL.md',
        'template/.agents/workflows/start-task.md'
    ]) {
        const content = readRepoFile(relativePath);
        assert.ok(content.includes(listGateText), `${relativePath} must preserve the start-banner gate-list instruction`);
    }

    for (const relativePath of [
        'template/skills/orchestration/SKILL.md',
        'template/skills/orchestration-depth1/SKILL.md',
        'template/.agents/workflows/start-task.md'
    ]) {
        const content = readRepoFile(relativePath);
        assert.ok(!content.includes(legacyStartMarker), `${relativePath} must not keep the legacy start marker`);
    }

    for (const relativePath of materializedGeneratedFiles) {
        const content = readGeneratedRepoFile(relativePath);
        if (
            relativePath.endsWith('/skills/orchestration/SKILL.md')
            || relativePath.endsWith('/docs/agent-rules/40-commands.md')
            || relativePath.endsWith('/docs/agent-rules/90-skill-catalog.md')
        ) {
            assert.ok(content.includes(startBannerToken), `${relativePath} must mention the repo-owned start banner flag`);
        }
        if (
            relativePath.endsWith('/skills/orchestration/SKILL.md')
            || relativePath.endsWith('/skills/orchestration-depth1/SKILL.md')
            || relativePath.endsWith('/.agents/workflows/start-task.md')
        ) {
            assert.ok(content.includes(listGateText), `${relativePath} must preserve the start-banner gate-list instruction`);
        }
        if (
            relativePath.endsWith('/template/CLAUDE.md')
            || relativePath.endsWith('/docs/agent-rules/80-task-workflow.md')
            || relativePath.endsWith('/skills/orchestration/SKILL.md')
            || relativePath.endsWith('/skills/orchestration-depth1/SKILL.md')
            || relativePath.endsWith('/.agents/workflows/start-task.md')
        ) {
            assert.ok(!content.includes(legacyStartMarker), `${relativePath} must not keep the legacy start marker`);
        }
    }
});

test('integrity-priority wording stays synced across tracked and materialized rule files', () => {
    const workflowSection = [
        '## Integrity Priority Rules',
        '- Honest execution and strict workflow compliance outrank speed, autonomy, context preservation, and token economy.',
        '- Mandatory gate failure means stop or `BLOCKED`; never workaround the gate, script around it, or claim progress that depends on missing evidence.',
        '- Agent-authored scripts may automate ordinary repository work, but they must not batch, loop over, or green-light orchestrator gates or write review, receipt, routing, telemetry, status, or commit-readiness evidence unless the task itself is to change orchestrator code.',
        '- Fabricated review artifacts, receipts, routing metadata, telemetry, task statuses, or commit-readiness claims are critical workflow violations.',
        '- If asked about workflow misconduct or integrity defects, disclose the full known set from the current run, not only the latest discovered issue.'
    ].join('\n');
    const skillCatalogSection = [
        '## Integrity Priority Rules',
        '- Honest execution and strict workflow compliance outrank speed, autonomy, context preservation, and token economy.',
        '- Skill routing, optional skills, and token-economy settings never authorize skipping mandatory gates or synthesizing workflow evidence.',
        '- Agent-authored scripts may automate ordinary repository work, but they must not batch, loop over, or green-light orchestrator gates or write review, receipt, routing, telemetry, status, or commit-readiness evidence unless the task itself is to change orchestrator code.',
        '- If asked about workflow misconduct or integrity defects, disclose the full known set from the current run, not only the latest discovered issue.'
    ].join('\n');

    for (const relativePath of [
        'template/docs/agent-rules/80-task-workflow.md',
        'template/docs/agent-rules/90-skill-catalog.md'
    ] as const) {
        const content = readRepoFile(relativePath);
        const sectionContent = extractMarkdownSection(content, '## Integrity Priority Rules');
        const expectedSection = relativePath.endsWith('80-task-workflow.md') ? workflowSection : skillCatalogSection;
        assert.equal(sectionContent.trim(), expectedSection, `${relativePath} must preserve exact integrity-priority section parity`);
    }

    for (const relativePath of [
        'garda-agent-orchestrator/live/docs/agent-rules/80-task-workflow.md',
        'garda-agent-orchestrator/live/docs/agent-rules/90-skill-catalog.md',
        'garda-agent-orchestrator/template/docs/agent-rules/80-task-workflow.md',
        'garda-agent-orchestrator/template/docs/agent-rules/90-skill-catalog.md'
    ] as const) {
        const content = readGeneratedRepoFile(relativePath);
        const sectionContent = extractMarkdownSection(content, '## Integrity Priority Rules');
        const expectedSection = relativePath.endsWith('80-task-workflow.md') ? workflowSection : skillCatalogSection;
        assert.equal(sectionContent.trim(), expectedSection, `${relativePath} must preserve exact integrity-priority section parity`);
    }
});

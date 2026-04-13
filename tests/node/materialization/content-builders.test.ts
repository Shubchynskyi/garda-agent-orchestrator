import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
    MANAGED_START,
    MANAGED_END,
    COMMIT_GUARD_START,
    COMMIT_GUARD_END,
    extractManagedBlockFromContent,
    getTaskQueueTableRange,
    getTaskQueueRowsFromManagedBlock,
    setTaskQueueRowsInManagedBlock,
    buildTaskManagedBlockWithExistingQueue,
    hasLegacyDepthColumn,
    migrateDepthToProfileRow,
    buildCanonicalManagedBlock,
    buildRedirectManagedBlock,
    buildCommitGuardManagedBlock,
    buildProviderOrchestratorAgentContent,
    buildSharedStartTaskWorkflowContent,
    buildGitHubSkillBridgeAgentContent,
    buildQwenSettingsContent,
    buildClaudeLocalSettingsContent,
    buildVscodeSettingsContent,
    stripJsoncComments,
    IDE_EXCLUDED_DIRECTORIES,
    getLegacyUninstallBackupGitignoreEntry,
    UNINSTALL_BACKUP_GITIGNORE_COMMENT,
    getUninstallBackupGitignoreEntry,
    buildGitignoreEntries,
    buildManagedGitignoreBlock,
    syncManagedGitignoreBlockInContent,
    syncManagedBlockInContent
} from '../../../src/materialization/content-builders';

describe('extractManagedBlockFromContent', () => {
    it('extracts block between markers', () => {
        const content = `before\n${MANAGED_START}\ninner\n${MANAGED_END}\nafter`;
        const result = extractManagedBlockFromContent(content, MANAGED_START, MANAGED_END);
        assert.ok(result!.includes('inner'));
        assert.ok(result!.startsWith(MANAGED_START));
        assert.ok(result!.endsWith(MANAGED_END));
    });

    it('returns null for missing markers', () => {
        assert.equal(extractManagedBlockFromContent('no markers here', MANAGED_START, MANAGED_END), null);
    });

    it('returns null for empty content', () => {
        assert.equal(extractManagedBlockFromContent('', MANAGED_START, MANAGED_END), null);
        assert.equal(extractManagedBlockFromContent(null, MANAGED_START, MANAGED_END), null);
    });
});

describe('task queue operations', () => {
    const taskBlock = [
        MANAGED_START,
        '## Active Queue',
        '| ID | Status | Profile |',
        '|---|---|---|',
        '| T-001 | IN_PROGRESS | default |',
        '| T-002 | BACKLOG | fast |',
        '',
        '## Notes',
        MANAGED_END
    ].join('\n');

    it('getTaskQueueTableRange parses correctly', () => {
        const range = getTaskQueueTableRange(taskBlock);
        assert.ok(range);
        assert.equal(range.rowsStartIndex, 4);
        assert.equal(range.rowsEndIndex, 6);
    });

    it('getTaskQueueRowsFromManagedBlock extracts rows', () => {
        const rows = getTaskQueueRowsFromManagedBlock(taskBlock);
        assert.equal(rows.length, 2);
        assert.ok(rows[0].includes('T-001'));
        assert.ok(rows[1].includes('T-002'));
    });

    it('setTaskQueueRowsInManagedBlock replaces rows', () => {
        const newRows = ['| T-003 | DONE | 3 |'];
        const result = setTaskQueueRowsInManagedBlock(taskBlock, newRows);
        assert.ok(result!.includes('T-003'));
        assert.ok(!result.includes('T-001'));
    });

    it('returns empty rows for no table', () => {
        const noTable = `${MANAGED_START}\nNo queue here\n${MANAGED_END}`;
        assert.deepEqual(getTaskQueueRowsFromManagedBlock(noTable), []);
    });
});

describe('buildTaskManagedBlockWithExistingQueue', () => {
    it('preserves existing queue rows in template block', () => {
        const template = `${MANAGED_START}\n## Active Queue\n| ID | Status |\n|---|---|\n| T-NEW | BACKLOG |\n${MANAGED_END}`;
        const existing = `${MANAGED_START}\n## Active Queue\n| ID | Status |\n|---|---|\n| T-OLD | DONE |\n${MANAGED_END}`;
        const result = buildTaskManagedBlockWithExistingQueue(template, existing);
        assert.ok(result!.includes('T-OLD'));
    });

    it('returns template block when no existing', () => {
        const template = `${MANAGED_START}\nTemplate content\n${MANAGED_END}`;
        const result = buildTaskManagedBlockWithExistingQueue(template, '');
        assert.ok(result!.includes('Template content'));
    });

    it('migrates legacy Depth rows to Profile=default during rewrite', () => {
        const template = [
            MANAGED_START,
            '## Active Queue',
            '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
            '|---|---|---|---|---|---|---|---|---|',
            '| T-NEW | TODO | P1 | area | task | me | 2026-01-01 | default | new |',
            MANAGED_END
        ].join('\n');
        const existing = [
            MANAGED_START,
            '## Active Queue',
            '| ID | Status | Priority | Area | Title | Owner | Updated | Depth | Notes |',
            '|---|---|---|---|---|---|---|---|---|',
            '| T-001 | DONE | P1 | area | task | me | 2026-01-01 | 2 | notes |',
            MANAGED_END
        ].join('\n');
        const result = buildTaskManagedBlockWithExistingQueue(template, existing);
        assert.ok(result!.includes('Profile'));
        assert.ok(result!.includes('default'));
        assert.ok(!result!.includes('| 2 |'));
        assert.ok(result!.includes('T-001'));
    });

    it('preserves existing notes when migrating Depth to Profile', () => {
        const template = [
            MANAGED_START,
            '## Active Queue',
            '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
            '|---|---|---|---|---|---|---|---|---|',
            MANAGED_END
        ].join('\n');
        const existing = [
            MANAGED_START,
            '## Active Queue',
            '| ID | Status | Priority | Area | Title | Owner | Updated | Depth | Notes |',
            '|---|---|---|---|---|---|---|---|---|',
            '| T-002 | DONE | P1 | area | task | me | 2026-01-01 | 3 | existing notes |',
            MANAGED_END
        ].join('\n');
        const result = buildTaskManagedBlockWithExistingQueue(template, existing);
        assert.ok(result!.includes('default'));
        assert.ok(result!.includes('requested_depth=3'));
        assert.ok(result!.includes('existing notes'));
    });

    it('skips depth note injection when requested_depth already in notes', () => {
        const template = [
            MANAGED_START,
            '## Active Queue',
            '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
            '|---|---|---|---|---|---|---|---|---|',
            MANAGED_END
        ].join('\n');
        const existing = [
            MANAGED_START,
            '## Active Queue',
            '| ID | Status | Priority | Area | Title | Owner | Updated | Depth | Notes |',
            '|---|---|---|---|---|---|---|---|---|',
            '| T-003 | DONE | P1 | area | task | me | 2026-01-01 | 2 | requested_depth=2; effective_depth=2 |',
            MANAGED_END
        ].join('\n');
        const result = buildTaskManagedBlockWithExistingQueue(template, existing);
        assert.ok(result!.includes('default'));
        // Should not duplicate requested_depth
        const matches = result!.match(/requested_depth/g);
        assert.equal(matches!.length, 1);
    });
});

describe('hasLegacyDepthColumn', () => {
    it('returns true for old Depth header', () => {
        assert.ok(hasLegacyDepthColumn('| ID | Status | Depth | Notes |'));
    });

    it('returns false for new Profile header', () => {
        assert.ok(!hasLegacyDepthColumn('| ID | Status | Profile | Notes |'));
    });

    it('returns false when both Depth and Profile exist', () => {
        assert.ok(!hasLegacyDepthColumn('| ID | Depth | Profile |'));
    });
});

describe('migrateDepthToProfileRow', () => {
    it('converts numeric depth to default', () => {
        const row = '| T-001 | DONE | P1 | area | task | me | 2026-01-01 | 2 | notes |';
        const result = migrateDepthToProfileRow(row);
        assert.ok(result.includes('default'));
        assert.ok(!result.includes('| 2 |'));
    });

    it('preserves non-numeric profile-like values as-is', () => {
        const row = '| T-001 | DONE | P1 | area | task | me | 2026-01-01 | custom | notes |';
        const result = migrateDepthToProfileRow(row);
        assert.ok(result.includes('custom'), 'Non-numeric values should be preserved');
        assert.ok(!result.includes('requested_depth'));
    });

    it('adds requested_depth to notes for numeric values', () => {
        const row = '| T-001 | DONE | P1 | area | task | me | 2026-01-01 | 3 | some notes |';
        const result = migrateDepthToProfileRow(row);
        assert.ok(result.includes('requested_depth=3'));
        assert.ok(result.includes('some notes'));
    });

    it('returns short rows unchanged', () => {
        const row = '| T-001 | DONE |';
        assert.equal(migrateDepthToProfileRow(row), row);
    });
});

describe('buildCanonicalManagedBlock', () => {
    it('replaces CLAUDE.md title with canonical file', () => {
        const templateClaudeContent = `${MANAGED_START}\n# CLAUDE.md\nSome content\n${MANAGED_END}`;
        const result = buildCanonicalManagedBlock('AGENTS.md', templateClaudeContent);
        assert.ok(result!.includes('# AGENTS.md'));
        assert.ok(!result.includes('# CLAUDE.md'));
    });

    it('restores clickable rule links in deployed canonical entrypoints', () => {
        const templateClaudeContent = `${MANAGED_START}
# CLAUDE.md
## Rule Files
- \`garda-agent-orchestrator/live/docs/agent-rules/00-core.md\`
- \`garda-agent-orchestrator/live/docs/agent-rules/40-commands.md\`
${MANAGED_END}`;
        const result = buildCanonicalManagedBlock('CLAUDE.md', templateClaudeContent);
        assert.ok(result!.includes('- [Core Rules](./garda-agent-orchestrator/live/docs/agent-rules/00-core.md)'));
        assert.ok(result!.includes('- [Commands](./garda-agent-orchestrator/live/docs/agent-rules/40-commands.md)'));
        assert.ok(!result.includes('- `garda-agent-orchestrator/live/docs/agent-rules/00-core.md`'));
    });

    it('throws for missing managed block', () => {
        assert.throws(
            () => buildCanonicalManagedBlock('AGENTS.md', 'no managed block'),
            /managed block is missing/
        );
    });
});

describe('buildRedirectManagedBlock', () => {
    it('generates redirect with provider bridge lines', () => {
        const result = buildRedirectManagedBlock(
            'AGENTS.md', 'CLAUDE.md',
            ['.github/agents/orchestrator.md']
        );
        assert.ok(result!.includes(MANAGED_START));
        assert.ok(result!.includes(MANAGED_END));
        assert.ok(result!.includes('# AGENTS.md'));
        assert.ok(result!.includes('redirect'));
        assert.ok(result!.includes('CLAUDE.md'));
        assert.ok(result!.includes('GitHub Copilot Agents'));
        assert.ok(result!.includes('.agents/workflows/start-task.md'));
    });

    it('shows no-bridge message when no providers', () => {
        const result = buildRedirectManagedBlock('GEMINI.md', 'CLAUDE.md', []);
        assert.ok(result!.includes('No provider-specific bridge files'));
    });

    it('includes compact-command protocol reference', () => {
        const result = buildRedirectManagedBlock(
            'AGENTS.md', 'CLAUDE.md',
            ['.github/agents/orchestrator.md']
        );
        assert.ok(result!.includes('compact command protocol'));
        assert.ok(result!.includes('scan'));
        assert.ok(result!.includes('inspect'));
        assert.ok(result!.includes('debug'));
    });
});

describe('buildCommitGuardManagedBlock', () => {
    it('produces valid bash hook script', () => {
        const result = buildCommitGuardManagedBlock();
        assert.ok(result!.includes(COMMIT_GUARD_START));
        assert.ok(result!.includes(COMMIT_GUARD_END));
        assert.ok(result!.includes('GARDA_ALLOW_COMMIT'));
        assert.ok(result!.includes('CODEX_THREAD_ID'));
        assert.ok(result!.includes('exit 1'));
    });
});

describe('buildProviderOrchestratorAgentContent', () => {
    it('includes required execution contract sections', () => {
        const result = buildProviderOrchestratorAgentContent('GitHub Copilot', 'CLAUDE.md', '.github/agents/orchestrator.md');
        assert.ok(result!.includes(MANAGED_START));
        assert.ok(result!.includes('GitHub Copilot Agent: Orchestrator'));
        assert.ok(result!.includes('Required Execution Contract'));
        assert.ok(result!.includes('Skill Routing'));
        assert.ok(result!.includes('Task Timeline Logging'));
        assert.ok(result!.includes('.github/agents/orchestrator.md'));
        assert.ok(result!.includes('.agents/workflows/start-task.md'));
    });

    it('includes compact-command protocol in full provider bridge', () => {
        const result = buildProviderOrchestratorAgentContent('GitHub Copilot', 'CLAUDE.md', '.github/agents/orchestrator.md');
        assert.ok(result!.includes('compact command protocol'));
        assert.ok(result!.includes('40-commands.md'));
    });

    it('builds a compact Antigravity router instead of a full duplicate workflow', () => {
        const result = buildProviderOrchestratorAgentContent('Antigravity', 'AGENTS.md', '.antigravity/agents/orchestrator.md');
        assert.ok(result.includes('Antigravity Agent: Orchestrator'));
        assert.ok(result.includes('.agents/workflows/start-task.md'));
        assert.ok(!result.includes('## Required Execution Contract'));
    });

    it('includes compact-command protocol in Antigravity bridge', () => {
        const result = buildProviderOrchestratorAgentContent('Antigravity', 'AGENTS.md', '.antigravity/agents/orchestrator.md');
        assert.ok(result!.includes('compact command protocol'));
        assert.ok(result!.includes('40-commands.md'));
    });
});

describe('buildSharedStartTaskWorkflowContent', () => {
    it('builds a compact checklist that routes every surface to canonical orchestration gates', () => {
        const result = buildSharedStartTaskWorkflowContent('AGENTS.md');
        assert.ok(result.includes('# Start Task'));
        assert.ok(result.includes('gate enter-task-mode'));
        assert.ok(result.includes('gate completion-gate'));
        assert.ok(result.includes('shared start-task router'));
        assert.ok(result.includes('If an active provider bridge exists'));
    });

    it('includes compact-command protocol reference', () => {
        const result = buildSharedStartTaskWorkflowContent('AGENTS.md');
        assert.ok(result.includes('compact command protocol'));
        assert.ok(result.includes('40-commands.md'));
    });
});

describe('buildGitHubSkillBridgeAgentContent', () => {
    it('includes skill bridge contract', () => {
        const result = buildGitHubSkillBridgeAgentContent(
            'Code Review Bridge', 'CLAUDE.md',
            'garda-agent-orchestrator/live/skills/code-review/SKILL.md',
            'required_reviews.code=true', 'always-on'
        );
        assert.ok(result!.includes(MANAGED_START));
        assert.ok(result!.includes('Code Review Bridge'));
        assert.ok(result!.includes('Skill Bridge Contract'));
        assert.ok(result!.includes('required_reviews.code=true'));
    });

    it('includes compact-command protocol reference', () => {
        const result = buildGitHubSkillBridgeAgentContent(
            'Code Review Bridge', 'CLAUDE.md',
            'garda-agent-orchestrator/live/skills/code-review/SKILL.md',
            'required_reviews.code=true', 'always-on'
        );
        assert.ok(result!.includes('compact command protocol'));
        assert.ok(result!.includes('40-commands.md'));
    });
});

describe('buildQwenSettingsContent', () => {
    it('creates new settings with required entries', () => {
        const result = buildQwenSettingsContent(null, ['TASK.md', 'CLAUDE.md']);
        assert.equal(result!.needsUpdate, true);
        const parsed = JSON.parse(result.content);
        assert.ok(parsed.context.fileName.includes('TASK.md'));
        assert.ok(parsed.context.fileName.includes('CLAUDE.md'));
    });

    it('merges into existing settings', () => {
        const existing = JSON.stringify({ context: { fileName: ['TASK.md'] }, other: 'value' });
        const result = buildQwenSettingsContent(existing, ['TASK.md', 'CLAUDE.md']);
        assert.equal(result!.needsUpdate, true);
        assert.equal(result!.parseMode, 'merge-existing');
        const parsed = JSON.parse(result.content);
        assert.ok(parsed.context.fileName.includes('CLAUDE.md'));
        assert.equal(parsed.other, 'value');
    });

    it('reports no update needed when all entries present', () => {
        const existing = JSON.stringify({ context: { fileName: ['TASK.md', 'CLAUDE.md'] } });
        const result = buildQwenSettingsContent(existing, ['TASK.md', 'CLAUDE.md']);
        assert.equal(result!.needsUpdate, false);
    });

    it('handles invalid JSON gracefully', () => {
        const result = buildQwenSettingsContent('not json', ['TASK.md']);
        assert.equal(result!.parseMode, 'invalid-json');
        assert.equal(result!.needsUpdate, true);
    });
});

describe('buildClaudeLocalSettingsContent', () => {
    it('adds orchestrator allow entries when enabled', () => {
        const result = buildClaudeLocalSettingsContent(null, true);
        assert.equal(result!.needsUpdate, true);
        const parsed = JSON.parse(result.content);
        assert.ok(parsed.permissions.allow.length > 0);
        assert.ok(parsed.permissions.allow.some((e: string) => e.includes('bin/garda.js')));
    });

    it('does not add entries when disabled', () => {
        const result = buildClaudeLocalSettingsContent(null, false);
        const parsed = JSON.parse(result.content);
        assert.equal(parsed.permissions.allow.length, 0);
    });
});

describe('buildGitignoreEntries', () => {
    it('includes core entries', () => {
        const entries = buildGitignoreEntries(['CLAUDE.md'], [], false);
        assert.ok(entries.includes('garda-agent-orchestrator/'));
        assert.ok(entries.includes('TASK.md'));
        assert.ok(entries.includes('.qwen/'));
    });

    it('includes .qwen/ in the managed baseline so later Qwen activation stays ignored', () => {
        const entries = buildGitignoreEntries(['CLAUDE.md'], [], false, true);
        assert.ok(entries.includes('.qwen/'));
    });

    it('adds AGENTS.md when active', () => {
        const entries = buildGitignoreEntries(['AGENTS.md'], [], false);
        assert.ok(entries.includes('AGENTS.md'));
    });

    it('adds QWEN.md when active', () => {
        const entries = buildGitignoreEntries(['QWEN.md'], [], false);
        assert.ok(entries.includes('QWEN.md'));
    });

    it('includes all supported entrypoint and provider ignore variants from the managed baseline', () => {
        const entries = buildGitignoreEntries(['CLAUDE.md'], [], false);
        assert.ok(entries.includes('CLAUDE.md'));
        assert.ok(entries.includes('AGENTS.md'));
        assert.ok(entries.includes('GEMINI.md'));
        assert.ok(entries.includes('QWEN.md'));
        assert.ok(entries.includes('.github/copilot-instructions.md'));
        assert.ok(entries.includes('.antigravity/'));
        assert.ok(entries.includes('.agents/workflows/start-task.md'));
        assert.ok(entries.includes('.junie/'));
        assert.ok(entries.includes('.windsurf/'));
        assert.ok(entries.includes('.qwen/'));
        assert.ok(!entries.includes('.windsurf/rules/rules.md'));
        assert.ok(!entries.includes('.junie/guidelines.md'));
        assert.ok(!entries.includes('.antigravity/rules.md'));
    });

    it('adds .claude/ when claude access enabled', () => {
        const entries = buildGitignoreEntries(['CLAUDE.md'], [], true);
        assert.ok(entries.includes('.claude/'));
    });

    it('includes provider gitignore entries', () => {
        const profiles = [{ gitignoreEntries: ['.github/agents/', '.github/copilot-instructions.md'] }];
        const entries = buildGitignoreEntries(['.github/copilot-instructions.md'], profiles, false);
        assert.ok(entries.includes('.github/agents/'));
    });
});

describe('managed gitignore block sync', () => {
    it('builds a single canonical managed block', () => {
        const block = buildManagedGitignoreBlock(['TASK.md', 'AGENTS.md'], '\n');
        assert.equal(block, '# garda-agent-orchestrator managed ignores\nAGENTS.md\nTASK.md');
    });

    it('replaces an existing managed block in place', () => {
        const content = [
            'node_modules/',
            '# garda-agent-orchestrator managed ignores',
            'TASK.md',
            '.antigravity/rules.md',
            '',
            'coverage/'
        ].join('\n');
        const result = syncManagedGitignoreBlockInContent(content, ['TASK.md', '.antigravity/'], false);
        assert.ok(result.changed);
        assert.equal((result.content.match(/# garda-agent-orchestrator managed ignores/g) || []).length, 1);
        assert.ok(result.content.includes('.antigravity/'));
        assert.ok(!result.content.includes('.antigravity/rules.md'));
        assert.ok(result.content.includes('coverage/'));
    });

    it('collapses multiple managed blocks into one canonical block', () => {
        const content = [
            'node_modules/',
            '# garda-agent-orchestrator managed ignores',
            'AGENTS.md',
            '',
            '# garda-agent-orchestrator managed ignores',
            '.antigravity/rules.md',
            'coverage/'
        ].join('\n');
        const result = syncManagedGitignoreBlockInContent(content, ['TASK.md', '.antigravity/'], false);
        assert.equal((result.content.match(/# garda-agent-orchestrator managed ignores/g) || []).length, 1);
        assert.ok(result.content.includes('.antigravity/'));
        assert.ok(!result.content.includes('AGENTS.md\n\n# garda-agent-orchestrator managed ignores'));
        assert.ok(result.content.includes('coverage/'));
    });

    it('appends a managed block once when missing', () => {
        const result = syncManagedGitignoreBlockInContent('node_modules/\n', ['TASK.md', 'AGENTS.md'], false);
        assert.ok(result.changed);
        assert.equal((result.content.match(/# garda-agent-orchestrator managed ignores/g) || []).length, 1);
        assert.ok(result.content.includes('node_modules/'));
    });

    it('migrates legacy uninstall backup ignore entries outside managed block', () => {
        const content = [
            'node_modules/',
            getUninstallBackupGitignoreEntry(),
            getLegacyUninstallBackupGitignoreEntry(),
            '# garda-agent-orchestrator managed ignores',
            'TASK.md'
        ].join('\n');
        const result = syncManagedGitignoreBlockInContent(content, ['TASK.md', 'AGENTS.md'], false);
        const lines = result.content.split(/\r?\n/);
        assert.ok(result.changed);
        assert.equal(lines.filter((line) => line === UNINSTALL_BACKUP_GITIGNORE_COMMENT).length, 1);
        assert.equal(lines.filter((line) => line === getUninstallBackupGitignoreEntry()).length, 1);
        assert.equal(lines.includes(getLegacyUninstallBackupGitignoreEntry()), false);
        assert.ok(lines.indexOf(getUninstallBackupGitignoreEntry()) < lines.indexOf('# garda-agent-orchestrator managed ignores'));
    });
});

describe('syncManagedBlockInContent', () => {
    it('replaces existing managed block', () => {
        const content = `before\r\n${MANAGED_START}\r\nold\r\n${MANAGED_END}\r\nafter`;
        const result = syncManagedBlockInContent(content, `${MANAGED_START}\r\nnew\r\n${MANAGED_END}`);
        assert.ok(result!.changed);
        assert.ok(result!.content.includes('new'));
        assert.ok(!result.content.includes('old'));
    });

    it('appends to empty content', () => {
        const result = syncManagedBlockInContent('', `${MANAGED_START}\ncontent\n${MANAGED_END}`);
        assert.ok(result!.changed);
        assert.ok(result!.content.includes(MANAGED_START));
    });

    it('replaces non-empty legacy content without block', () => {
        const result = syncManagedBlockInContent('existing content', `${MANAGED_START}\ncontent\n${MANAGED_END}`);
        assert.ok(result!.changed);
        assert.ok(result!.content.includes(MANAGED_START));
        assert.ok(!result.content.includes('existing content'));
    });
});

describe('buildVscodeSettingsContent', () => {
    it('creates settings with all IDE_EXCLUDED_DIRECTORIES when starting from empty', () => {
        const result = buildVscodeSettingsContent(null);
        assert.equal(result.needsUpdate, true);
        assert.equal(result.parseMode, 'default');

        const parsed = JSON.parse(result.content);
        for (const dir of IDE_EXCLUDED_DIRECTORIES) {
            const pattern = `**/${dir}`;
            assert.equal(parsed['files.exclude'][pattern], true, `files.exclude should have ${pattern}`);
            assert.equal(parsed['search.exclude'][pattern], true, `search.exclude should have ${pattern}`);
            assert.equal(parsed['files.watcherExclude'][pattern], true, `files.watcherExclude should have ${pattern}`);
        }
    });

    it('merges into existing settings without losing user entries', () => {
        const existing = JSON.stringify({
            'editor.fontSize': 14,
            'files.exclude': { '**/.git': true },
            'search.exclude': { '**/coverage': true }
        }, null, 2);
        const result = buildVscodeSettingsContent(existing);
        assert.equal(result.needsUpdate, true);
        assert.equal(result.parseMode, 'merge-existing');

        const parsed = JSON.parse(result.content);
        assert.equal(parsed['editor.fontSize'], 14, 'should preserve user settings');
        assert.equal(parsed['files.exclude']['**/.git'], true, 'should preserve existing excludes');
        assert.equal(parsed['search.exclude']['**/coverage'], true, 'should preserve existing excludes');
        assert.equal(parsed['files.exclude']['**/garda-agent-orchestrator'], true);
        assert.equal(parsed['search.exclude']['**/garda-agent-orchestrator'], true);
    });

    it('reports no update needed when all patterns already present', () => {
        const excludeMap: Record<string, boolean> = {};
        for (const dir of IDE_EXCLUDED_DIRECTORIES) {
            excludeMap[`**/${dir}`] = true;
        }
        const existing = JSON.stringify({
            'files.exclude': { ...excludeMap },
            'search.exclude': { ...excludeMap },
            'files.watcherExclude': { ...excludeMap }
        }, null, 2);
        const result = buildVscodeSettingsContent(existing);
        assert.equal(result.needsUpdate, false);
        assert.equal(result.parseMode, 'merge-existing');
    });

    it('handles invalid JSON gracefully', () => {
        const result = buildVscodeSettingsContent('not valid json');
        assert.equal(result.needsUpdate, true);
        assert.equal(result.parseMode, 'invalid-json');
        const parsed = JSON.parse(result.content);
        assert.equal(parsed['files.exclude']['**/dist'], true);
    });

    it('handles JSONC with comments without losing user settings', () => {
        const jsonc = [
            '{',
            '  // User comment about font size',
            '  "editor.fontSize": 14,',
            '  /* Block comment */',
            '  "files.exclude": { "**/.git": true }',
            '}'
        ].join('\n');
        const result = buildVscodeSettingsContent(jsonc);
        assert.equal(result.needsUpdate, true);
        assert.equal(result.parseMode, 'merge-existing');
        const parsed = JSON.parse(result.content);
        assert.equal(parsed['editor.fontSize'], 14, 'should preserve user settings from JSONC');
        assert.equal(parsed['files.exclude']['**/.git'], true, 'should preserve existing excludes');
        assert.equal(parsed['files.exclude']['**/dist'], true, 'should add orchestrator excludes');
    });

    it('handles JSONC with trailing commas', () => {
        const jsonc = '{\n  "editor.fontSize": 14,\n  "files.exclude": { "**/.git": true, },\n}';
        const result = buildVscodeSettingsContent(jsonc);
        assert.equal(result.parseMode, 'merge-existing');
        const parsed = JSON.parse(result.content);
        assert.equal(parsed['editor.fontSize'], 14);
        assert.equal(parsed['files.exclude']['**/.git'], true);
    });
});

describe('stripJsoncComments', () => {
    it('strips single-line comments', () => {
        const result = stripJsoncComments('{ // comment\n  "key": "val" }');
        assert.ok(JSON.parse(result));
        assert.equal(JSON.parse(result).key, 'val');
    });

    it('strips block comments', () => {
        const result = stripJsoncComments('{ /* comment */ "key": "val" }');
        assert.equal(JSON.parse(result).key, 'val');
    });

    it('preserves comment-like sequences inside strings', () => {
        const result = stripJsoncComments('{ "url": "http://example.com" }');
        assert.equal(JSON.parse(result).url, 'http://example.com');
    });

    it('returns empty string for empty input', () => {
        assert.equal(stripJsoncComments(''), '');
    });

    it('handles trailing commas', () => {
        const jsonc = '{ "a": 1, "b": 2, }';
        const result = stripJsoncComments(jsonc);
        const parsed = JSON.parse(result);
        assert.equal(parsed.a, 1);
        assert.equal(parsed.b, 2);
    });

    it('handles JSONC with both comments and trailing commas', () => {
        const jsonc = [
            '{',
            '  // this is a comment',
            '  "editor.fontSize": 14,',
            '  "files.exclude": {',
            '    "**/.git": true, // trailing comma',
            '  },',
            '}'
        ].join('\n');
        const result = stripJsoncComments(jsonc);
        const parsed = JSON.parse(result);
        assert.equal(parsed['editor.fontSize'], 14);
        assert.equal(parsed['files.exclude']['**/.git'], true);
    });

    it('preserves comma-bracket sequences inside strings', () => {
        const input = '{ "text": ",}", "n": 1 }';
        const result = stripJsoncComments(input);
        const parsed = JSON.parse(result);
        assert.equal(parsed.text, ',}', 'comma-bracket inside string must not be altered');
        assert.equal(parsed.n, 1);
    });
});

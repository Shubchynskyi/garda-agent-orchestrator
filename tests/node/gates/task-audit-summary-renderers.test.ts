import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildCommitCommandSuggestion } from '../../../src/gates/task-audit-summary-renderers';

describe('buildCommitCommandSuggestion', () => {
    it('returns human-commit command when commit guard is ON', () => {
        const changedFiles = ['src/example.ts'];
        const metadata = {
            id: 'T-123',
            status: 'IN_PROGRESS',
            priority: 'P1',
            area: 'core',
            title: 'Fix the thing',
            assignee: 'unassigned',
            updated: '2026-04-30',
            profile: 'default',
            notes: 'fixture',
            isPlaceholder: false
        };
        const result = buildCommitCommandSuggestion(changedFiles, metadata, true);
        assert.ok(result.template.includes('human-commit'), 'Template should use human-commit');
        assert.ok(result.suggestion.includes('human-commit'), 'Suggestion should use human-commit');
        assert.ok(!result.template.includes('git commit -m'), 'Template should not use bare git commit');
        assert.ok(!result.suggestion.includes('git commit -m'), 'Suggestion should not use bare git commit');
    });

    it('returns git commit command when commit guard is OFF', () => {
        const changedFiles = ['src/example.ts'];
        const metadata = {
            id: 'T-123',
            status: 'IN_PROGRESS',
            priority: 'P1',
            area: 'core',
            title: 'Fix the thing',
            assignee: 'unassigned',
            updated: '2026-04-30',
            profile: 'default',
            notes: 'fixture',
            isPlaceholder: false
        };
        const result = buildCommitCommandSuggestion(changedFiles, metadata, false);
        assert.ok(!result.template.includes('human-commit'), 'Template should not use human-commit');
        assert.ok(!result.suggestion.includes('human-commit'), 'Suggestion should not use human-commit');
        assert.ok(result.template.includes('git commit -m'), 'Template should use bare git commit');
        assert.ok(result.suggestion.includes('git commit -m'), 'Suggestion should use bare git commit');
    });
});

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildCommitCommandSuggestion } from '../../../../src/gates/task-audit/task-audit-summary-renderers';

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
        assert.ok(result.template.includes('--operator-confirmed yes'), 'Template should require operator confirmation');
        assert.ok(result.suggestion.includes('--operator-confirmed yes'), 'Suggestion should require operator confirmation');
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

    it('uses the task title instead of a one-word area suffix for informative suggestions', () => {
        const changedFiles = ['src/example.ts'];
        const metadata = {
            id: 'T-546',
            status: 'IN_PROGRESS',
            priority: 'P2',
            area: 'settings',
            title: 'Improve settings validation feedback',
            assignee: 'unassigned',
            updated: '2026-05-14',
            profile: 'balanced',
            notes: 'fixture',
            isPlaceholder: false
        };

        const result = buildCommitCommandSuggestion(changedFiles, metadata, false);

        assert.equal(result.suggestion, 'git commit -m "fix(settings): improve settings validation feedback"');
        assert.ok(!result.suggestion.includes('feat(settings): settings'));
    });

    it('falls back to the template when both area and title would be tautological', () => {
        const changedFiles = ['src/example.ts'];
        const metadata = {
            id: 'T-547',
            status: 'IN_PROGRESS',
            priority: 'P2',
            area: 'settings',
            title: 'Settings',
            assignee: 'unassigned',
            updated: '2026-05-14',
            profile: 'balanced',
            notes: 'fixture',
            isPlaceholder: false
        };

        const result = buildCommitCommandSuggestion(changedFiles, metadata, false);

        assert.equal(result.suggestion, 'git commit -m "<type>(<scope>): <summary>"');
    });
});

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
    getManagedGitignoreEntries,
    getManagedGitignoreCleanupEntries,
    getProviderOrchestratorProfileDefinitions
} from '../../../src/materialization/common';
import {
    buildGitignoreEntries
} from '../../../src/materialization/content-builders';
import {
    validateInitAnswers,
    serializeInitAnswers
} from '../../../src/schemas/init-answers';

// ---------------------------------------------------------------------------
// getManagedGitignoreEntries — provider minimalism scoping
// ---------------------------------------------------------------------------

describe('getManagedGitignoreEntries with activeEntryFiles (provider minimalism)', () => {
    it('includes only the canonical provider when scoped to a single active file', () => {
        const entries = getManagedGitignoreEntries(false, ['.github/copilot-instructions.md']);
        assert.ok(entries.includes('.github/copilot-instructions.md'));
        assert.ok(entries.includes('.github/agents/'));
        // Should NOT include unrelated providers
        assert.ok(!entries.includes('CLAUDE.md'));
        assert.ok(!entries.includes('AGENTS.md'));
        assert.ok(!entries.includes('GEMINI.md'));
        assert.ok(!entries.includes('QWEN.md'));
    });

    it('includes multiple active providers when specified', () => {
        const entries = getManagedGitignoreEntries(false, ['CLAUDE.md', '.github/copilot-instructions.md']);
        assert.ok(entries.includes('CLAUDE.md'));
        assert.ok(entries.includes('.github/copilot-instructions.md'));
        assert.ok(entries.includes('.github/agents/'));
        assert.ok(!entries.includes('AGENTS.md'));
        assert.ok(!entries.includes('GEMINI.md'));
    });

    it('always includes bundle root, TASK.md, .qwen/, and start-task router', () => {
        const entries = getManagedGitignoreEntries(false, ['CLAUDE.md']);
        assert.ok(entries.some(e => e.endsWith('/')), 'should have bundle root dir');
        assert.ok(entries.includes('TASK.md'));
        assert.ok(entries.includes('.qwen/'));
        assert.ok(entries.includes('.agents/workflows/start-task.md'));
    });

    it('does not include directory-scoped legacy entries as file-level ignores', () => {
        const entries = getManagedGitignoreEntries(false, ['.windsurf/rules/rules.md']);
        // .windsurf/ directory entry should be present (from provider profile)
        assert.ok(entries.includes('.windsurf/'));
        // But the file-level legacy entry should not be present
        assert.ok(!entries.includes('.windsurf/rules/rules.md'));
    });

    it('falls back to full superset when activeEntryFiles is undefined', () => {
        const scoped = getManagedGitignoreEntries(false, ['CLAUDE.md']);
        const full = getManagedGitignoreEntries(false);
        assert.ok(full.length > scoped.length, 'full superset should have more entries');
        assert.ok(full.includes('CLAUDE.md'));
        assert.ok(full.includes('AGENTS.md'));
        assert.ok(full.includes('GEMINI.md'));
        assert.ok(full.includes('.github/copilot-instructions.md'));
    });

    it('includes .claude/ when enableClaudeOrchestratorFullAccess is true', () => {
        const entries = getManagedGitignoreEntries(true, ['CLAUDE.md']);
        assert.ok(entries.includes('.claude/'));
        assert.ok(entries.includes('CLAUDE.md'));
    });
});

describe('getManagedGitignoreCleanupEntries with activeEntryFiles', () => {
    it('includes legacy entries even with scoped active files', () => {
        const cleanup = getManagedGitignoreCleanupEntries(false, ['CLAUDE.md']);
        assert.ok(cleanup.includes('.windsurf/rules/rules.md'));
        assert.ok(cleanup.includes('.junie/guidelines.md'));
        assert.ok(cleanup.includes('.antigravity/rules.md'));
    });
});

// ---------------------------------------------------------------------------
// buildGitignoreEntries — providerMinimalism flag
// ---------------------------------------------------------------------------

describe('buildGitignoreEntries with providerMinimalism', () => {
    const allProfiles = getProviderOrchestratorProfileDefinitions();
    const copilotProfile = allProfiles.filter(p => p.entrypointFile === '.github/copilot-instructions.md');

    it('produces smaller entry set when providerMinimalism is true', () => {
        const minimal = buildGitignoreEntries(
            ['.github/copilot-instructions.md'],
            copilotProfile,
            false,
            false,
            true
        );
        const full = buildGitignoreEntries(
            ['.github/copilot-instructions.md'],
            copilotProfile,
            false,
            false,
            false
        );
        assert.ok(minimal.length <= full.length, `minimal (${minimal.length}) should be <= full (${full.length})`);
        // Full mode includes all provider entries even when only copilot is active
        assert.ok(full.includes('CLAUDE.md'));
        assert.ok(full.includes('AGENTS.md'));
        // Minimal mode should not include unrelated providers
        assert.ok(!minimal.includes('CLAUDE.md'));
        assert.ok(!minimal.includes('AGENTS.md'));
    });

    it('includes active entry files in both modes', () => {
        const minimal = buildGitignoreEntries(
            ['.github/copilot-instructions.md'],
            copilotProfile,
            false,
            false,
            true
        );
        assert.ok(minimal.includes('.github/copilot-instructions.md'));
        assert.ok(minimal.includes('.github/agents/'));
    });
});

// ---------------------------------------------------------------------------
// validateInitAnswers — ProviderMinimalism field
// ---------------------------------------------------------------------------

describe('validateInitAnswers ProviderMinimalism', () => {
    const baseAnswers = {
        AssistantLanguage: 'English',
        AssistantBrevity: 'concise',
        SourceOfTruth: 'Claude',
        EnforceNoAutoCommit: 'true',
        ClaudeOrchestratorFullAccess: 'false',
        TokenEconomyEnabled: 'true',
        CollectedVia: 'CLI_NONINTERACTIVE'
    };

    it('defaults ProviderMinimalism to true when absent', () => {
        const result = validateInitAnswers(baseAnswers);
        assert.equal(result.ProviderMinimalism, true);
    });

    it('respects explicit true', () => {
        const result = validateInitAnswers({ ...baseAnswers, ProviderMinimalism: 'true' });
        assert.equal(result.ProviderMinimalism, true);
    });

    it('respects explicit false', () => {
        const result = validateInitAnswers({ ...baseAnswers, ProviderMinimalism: 'false' });
        assert.equal(result.ProviderMinimalism, false);
    });
});

// ---------------------------------------------------------------------------
// serializeInitAnswers — ProviderMinimalism round-trip
// ---------------------------------------------------------------------------

describe('serializeInitAnswers ProviderMinimalism', () => {
    const baseAnswers = {
        AssistantLanguage: 'English',
        AssistantBrevity: 'concise',
        SourceOfTruth: 'Claude',
        EnforceNoAutoCommit: 'true',
        ClaudeOrchestratorFullAccess: 'false',
        TokenEconomyEnabled: 'true',
        CollectedVia: 'CLI_NONINTERACTIVE'
    };

    it('serializes default ProviderMinimalism as "true"', () => {
        const serialized = serializeInitAnswers(baseAnswers);
        assert.equal(serialized.ProviderMinimalism, 'true');
    });

    it('serializes explicit false as "false"', () => {
        const serialized = serializeInitAnswers({ ...baseAnswers, ProviderMinimalism: 'false' });
        assert.equal(serialized.ProviderMinimalism, 'false');
    });

    it('round-trips through validate -> serialize -> validate', () => {
        const first = validateInitAnswers({ ...baseAnswers, ProviderMinimalism: 'false' });
        assert.equal(first.ProviderMinimalism, false);
        const serialized = serializeInitAnswers({ ...baseAnswers, ProviderMinimalism: 'false' });
        const second = validateInitAnswers(serialized);
        assert.equal(second.ProviderMinimalism, false);
    });
});

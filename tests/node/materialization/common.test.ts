import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
    getCanonicalEntrypointFile,
    normalizeAgentEntrypointToken,
    getActiveAgentEntrypointFiles,
    convertActiveAgentEntrypointFilesToString,
    getProviderOrchestratorProfileDefinitions,
    getGitHubSkillBridgeProfileDefinitions,
    getManagedGitignoreEntries,
    getManagedGitignoreCleanupEntries
} from '../../../src/materialization/common';
import { getManagedAgentignoreActiveEntries } from '../../../src/materialization/content-builders';

describe('getCanonicalEntrypointFile', () => {
    it('maps all source-of-truth values to entrypoint files', () => {
        assert.equal(getCanonicalEntrypointFile('Claude'), 'CLAUDE.md');
        assert.equal(getCanonicalEntrypointFile('Codex'), 'AGENTS.md');
        assert.equal(getCanonicalEntrypointFile('Cursor'), 'AGENTS.md');
        assert.equal(getCanonicalEntrypointFile('Gemini'), 'GEMINI.md');
        assert.equal(getCanonicalEntrypointFile('Qwen'), 'QWEN.md');
        assert.equal(getCanonicalEntrypointFile('GitHubCopilot'), '.github/copilot-instructions.md');
        assert.equal(getCanonicalEntrypointFile('Windsurf'), '.windsurf/rules/rules.md');
        assert.equal(getCanonicalEntrypointFile('Junie'), '.junie/guidelines.md');
        assert.equal(getCanonicalEntrypointFile('Antigravity'), '.antigravity/rules.md');
    });

    it('is case-insensitive', () => {
        assert.equal(getCanonicalEntrypointFile('claude'), 'CLAUDE.md');
        assert.equal(getCanonicalEntrypointFile('CLAUDE'), 'CLAUDE.md');
    });

    it('throws for unsupported values', () => {
        assert.throws(() => getCanonicalEntrypointFile('unknown'), /Unsupported SourceOfTruth/);
    });
});

describe('normalizeAgentEntrypointToken', () => {
    it('resolves aliases to canonical paths', () => {
        assert.equal(normalizeAgentEntrypointToken('claude'), 'CLAUDE.md');
        assert.equal(normalizeAgentEntrypointToken('codex'), 'AGENTS.md');
        assert.equal(normalizeAgentEntrypointToken('copilot'), '.github/copilot-instructions.md');
        assert.equal(normalizeAgentEntrypointToken('windsurf'), '.windsurf/rules/rules.md');
        assert.equal(normalizeAgentEntrypointToken('qwen'), 'QWEN.md');
        assert.equal(normalizeAgentEntrypointToken('qwen.md'), 'QWEN.md');
    });

    it('resolves numeric selections', () => {
        assert.equal(normalizeAgentEntrypointToken('1'), 'CLAUDE.md');
        assert.equal(normalizeAgentEntrypointToken('2'), 'AGENTS.md');
        assert.equal(normalizeAgentEntrypointToken('4'), 'QWEN.md');
    });

    it('strips leading "or" prefix', () => {
        assert.equal(normalizeAgentEntrypointToken('or CLAUDE.md'), 'CLAUDE.md');
    });

    it('returns null for empty token', () => {
        assert.equal(normalizeAgentEntrypointToken(''), null);
    });

    it('throws for invalid number', () => {
        assert.throws(() => normalizeAgentEntrypointToken('99'), /Unsupported ActiveAgentFiles selection/);
    });

    it('throws for unknown token', () => {
        assert.throws(() => normalizeAgentEntrypointToken('unknownprovider'), /Unsupported ActiveAgentFiles entry/);
    });
});

describe('getActiveAgentEntrypointFiles', () => {
    it('parses comma-separated entries and includes source-of-truth', () => {
        const result = getActiveAgentEntrypointFiles('CLAUDE.md, AGENTS.md', 'Claude');
        assert.ok(result.includes('CLAUDE.md'));
        assert.ok(result.includes('AGENTS.md'));
    });

    it('falls back to source-of-truth when value is empty', () => {
        const result = getActiveAgentEntrypointFiles('', 'Codex');
        assert.deepEqual(result, ['AGENTS.md']);
    });

    it('returns ordered by canonical order', () => {
        const result = getActiveAgentEntrypointFiles('AGENTS.md, CLAUDE.md', 'Claude');
        assert.equal(result[0], 'CLAUDE.md');
        assert.equal(result[1], 'AGENTS.md');
    });
});

describe('convertActiveAgentEntrypointFilesToString', () => {
    it('converts array to comma-separated string', () => {
        const result = convertActiveAgentEntrypointFilesToString(['CLAUDE.md', 'AGENTS.md']);
        assert.equal(result, 'CLAUDE.md, AGENTS.md');
    });

    it('returns null for empty array', () => {
        assert.equal(convertActiveAgentEntrypointFilesToString([]), null);
    });
});

describe('getProviderOrchestratorProfileDefinitions', () => {
    it('returns 4 provider profiles with required properties', () => {
        const profiles = getProviderOrchestratorProfileDefinitions();
        assert.equal(profiles.length, 4);
        for (const p of profiles) {
            assert.ok(p.entrypointFile);
            assert.ok(p.providerLabel);
            assert.ok(p.orchestratorRelativePath);
            assert.ok(Array.isArray(p.gitignoreEntries));
        }
    });

    it('uses directory-only ignores for directory-scoped providers', () => {
        const profiles = getProviderOrchestratorProfileDefinitions();
        const windsurf = profiles.find((p) => p.providerLabel === 'Windsurf');
        const junie = profiles.find((p) => p.providerLabel === 'Junie');
        const antigravity = profiles.find((p) => p.providerLabel === 'Antigravity');
        assert.deepEqual(windsurf!.gitignoreEntries, ['.windsurf/']);
        assert.deepEqual(junie!.gitignoreEntries, ['.junie/']);
        assert.deepEqual(antigravity!.gitignoreEntries, ['.antigravity/']);
    });
});

describe('managed gitignore entries', () => {
    it('includes all supported entrypoints in the baseline', () => {
        const entries = getManagedGitignoreEntries(false);
        assert.ok(entries.includes('CLAUDE.md'));
        assert.ok(entries.includes('AGENTS.md'));
        assert.ok(entries.includes('GEMINI.md'));
        assert.ok(entries.includes('QWEN.md'));
        assert.ok(entries.includes('.agentignore'));
        assert.ok(entries.includes('.github/copilot-instructions.md'));
        assert.ok(entries.includes('.agents/workflows/start-task.md'));
    });

    it('keeps legacy nested provider file ignores only in cleanup mode', () => {
        const baseline = getManagedGitignoreEntries(false);
        const cleanup = getManagedGitignoreCleanupEntries(false);
        assert.ok(!baseline.includes('.windsurf/rules/rules.md'));
        assert.ok(!baseline.includes('.junie/guidelines.md'));
        assert.ok(!baseline.includes('.antigravity/rules.md'));
        assert.ok(cleanup.includes('.windsurf/rules/rules.md'));
        assert.ok(cleanup.includes('.junie/guidelines.md'));
        assert.ok(cleanup.includes('.antigravity/rules.md'));
    });
});

describe('managed agentignore active entries', () => {
    it('hides bulky Garda artifacts without hiding command and rule surfaces', () => {
        const entries = getManagedAgentignoreActiveEntries('garda-agent-orchestrator');

        assert.ok(entries.includes('garda-agent-orchestrator/dist/'));
        assert.ok(entries.includes('garda-agent-orchestrator/src/'));
        assert.ok(entries.includes('garda-agent-orchestrator/template/'));
        assert.ok(entries.includes('garda-agent-orchestrator/runtime/update-rollbacks/'));
        assert.ok(entries.includes('garda-agent-orchestrator/runtime/tmp/'));
        assert.ok(entries.includes('garda-agent-orchestrator/runtime/metrics/'));
        assert.ok(entries.includes('garda-agent-orchestrator/runtime/full-suite/'));
        assert.ok(entries.includes('garda-agent-orchestrator/runtime/scoped-diffs/'));
        assert.ok(entries.includes('garda-agent-orchestrator/runtime/reviews/*-review-context.md'));
        assert.ok(entries.includes('garda-agent-orchestrator/runtime/task-events/index*.json'));
        assert.ok(entries.includes('garda-agent-orchestrator/runtime/timeline-summaries/'));
        assert.ok(!entries.includes('AGENTS.md'));
        assert.ok(!entries.includes('.agents/workflows/start-task.md'));
        assert.ok(!entries.includes('garda-agent-orchestrator/bin/garda.js'));
        assert.ok(!entries.includes('garda-agent-orchestrator/live/docs/agent-rules/'));
        assert.ok(!entries.includes('garda-agent-orchestrator/live/config/'));
        assert.ok(!entries.includes('garda-agent-orchestrator/runtime/protected-control-plane-manifest.json'));
        assert.ok(!entries.includes('garda-agent-orchestrator/'));
    });
});

describe('getGitHubSkillBridgeProfileDefinitions', () => {
    it('returns 10 skill bridge profiles', () => {
        const profiles = getGitHubSkillBridgeProfileDefinitions();
        assert.equal(profiles.length, 10);
        for (const p of profiles) {
            assert.ok(p.relativePath);
            assert.ok(p.profileTitle);
            assert.ok(p.skillPath);
            assert.ok(p.reviewRequirement);
            assert.ok(p.capabilityFlag);
        }
    });
});

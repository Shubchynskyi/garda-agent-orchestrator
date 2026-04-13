import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import { runReinit, recollectInitAnswers, getOptionalValue, ReinitChange } from '../../../src/materialization/reinit';

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
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-reinit-'));
    const bundle = path.join(tmpDir, 'garda-agent-orchestrator');
    fs.mkdirSync(bundle, { recursive: true });
    fs.copyFileSync(path.join(bundleRoot, 'VERSION'), path.join(bundle, 'VERSION'));
    copyDirRecursive(path.join(bundleRoot, 'template'), path.join(bundle, 'template'));
    fs.mkdirSync(path.join(bundle, 'runtime'), { recursive: true });
    fs.mkdirSync(path.join(bundle, 'live/docs/agent-rules'), { recursive: true });
    fs.mkdirSync(path.join(bundle, 'live/config'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, '.git', 'hooks'), { recursive: true });

    // Copy template rule files to live for init source selection
    const templateRules = path.join(bundle, 'template/docs/agent-rules');
    const liveRules = path.join(bundle, 'live/docs/agent-rules');
    if (fs.existsSync(templateRules)) {
        for (const entry of fs.readdirSync(templateRules)) {
            fs.copyFileSync(path.join(templateRules, entry), path.join(liveRules, entry));
        }
    }

    // Copy template config to live
    const templateConfig = path.join(bundle, 'template/config');
    const liveConfig = path.join(bundle, 'live/config');
    if (fs.existsSync(templateConfig)) {
        for (const entry of fs.readdirSync(templateConfig)) {
            fs.copyFileSync(path.join(templateConfig, entry), path.join(liveConfig, entry));
        }
    }

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

function seedStaleTaskEventLock(bundleRoot: string, lockName: string) {
    const lockPath = path.join(bundleRoot, 'runtime', 'task-events', lockName);
    const oldDate = new Date('2020-01-01T00:00:00.000Z');
    fs.mkdirSync(lockPath, { recursive: true });
    fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
        pid: 999999,
        hostname: os.hostname(),
        created_at_utc: '2020-01-01T00:00:00.000Z'
    }), 'utf8');
    fs.utimesSync(path.join(lockPath, 'owner.json'), oldDate, oldDate);
    fs.utimesSync(lockPath, oldDate, oldDate);
}

describe('getOptionalValue', () => {
    it('does case-insensitive lookup', () => {
        assert.equal(getOptionalValue({ AssistantLanguage: 'English' }, 'assistantlanguage'), 'English');
        assert.equal(getOptionalValue({ assistantlanguage: 'English' }, 'AssistantLanguage'), 'English');
    });

    it('returns null for missing key', () => {
        assert.equal(getOptionalValue({ a: 1 }, 'missing'), null);
    });

    it('returns null for null/undefined object', () => {
        assert.equal(getOptionalValue(null, 'key'), null);
        assert.equal(getOptionalValue(undefined, 'key'), null);
    });

    it('strips underscores and hyphens for matching', () => {
        assert.equal(getOptionalValue({ 'assistant_language': 'English' }, 'AssistantLanguage'), 'English');
    });
});

describe('recollectInitAnswers', () => {
    it('preserves existing answers', () => {
        const changes: ReinitChange[] = [];
        const result = recollectInitAnswers({
            existingAnswers: {
                AssistantLanguage: 'Russian',
                AssistantBrevity: 'detailed',
                SourceOfTruth: 'Codex',
                ActiveAgentFiles: 'CLAUDE.md, AGENTS.md',
                EnforceNoAutoCommit: 'true',
                ClaudeOrchestratorFullAccess: 'false',
                TokenEconomyEnabled: 'true',
                ProviderMinimalism: 'false',
                CollectedVia: 'AGENT_INIT_PROMPT.md'
            },
            changes
        });

        assert.equal(result.AssistantLanguage, 'Russian');
        assert.equal(result.AssistantBrevity, 'detailed');
        assert.equal(result.SourceOfTruth, 'Codex');
        assert.equal(result.ActiveAgentFiles, 'CLAUDE.md, AGENTS.md');
        assert.equal(result.ProviderMinimalism, 'false');
        const preservedCount = changes.filter((c) => c.action === 'preserved').length;
        assert.ok(preservedCount >= 7);
    });

    it('applies overrides over existing', () => {
        const changes: ReinitChange[] = [];
        const result = recollectInitAnswers({
            existingAnswers: {
                AssistantLanguage: 'English',
                AssistantBrevity: 'concise',
                SourceOfTruth: 'Claude',
                EnforceNoAutoCommit: 'false',
                ClaudeOrchestratorFullAccess: 'false',
                TokenEconomyEnabled: 'true',
                CollectedVia: 'CLI_NONINTERACTIVE'
            },
            overrides: { AssistantLanguage: 'German' },
            changes
        });

        assert.equal(result.AssistantLanguage, 'German');
        const overridden = changes.filter((c) => c.action === 'overridden');
        assert.ok(overridden.length >= 1);
    });

    it('uses defaults when no existing or overrides', () => {
        const changes: ReinitChange[] = [];
        const result = recollectInitAnswers({ changes });

        assert.equal(result.AssistantLanguage, 'English');
        assert.equal(result.AssistantBrevity, 'concise');
        assert.equal(result.SourceOfTruth, 'Claude');
        const defaulted = changes.filter((c) => c.action === 'recommended_default');
        assert.ok(defaulted.length >= 5);
    });

    it('infers from live version.json', () => {
        const changes: ReinitChange[] = [];
        const result = recollectInitAnswers({
            liveVersion: { AssistantLanguage: 'French', SourceOfTruth: 'Windsurf' },
            changes
        });

        assert.equal(result.AssistantLanguage, 'French');
        assert.equal(result.SourceOfTruth, 'Windsurf');
        const inferred = changes.filter((c) => c.action === 'inferred');
        assert.ok(inferred.length >= 2);
    });

    it('infers TokenEconomyEnabled from token-economy.json', () => {
        const changes: ReinitChange[] = [];
        const result = recollectInitAnswers({
            tokenEconomyConfig: { enabled: false },
            changes
        });

        assert.equal(result.TokenEconomyEnabled, 'false');
    });

    it('infers ProviderMinimalism from live version.json', () => {
        const changes: ReinitChange[] = [];
        const result = recollectInitAnswers({
            liveVersion: { ProviderMinimalism: false },
            changes
        });

        assert.equal(result.ProviderMinimalism, 'false');
    });
});

describe('runReinit', () => {
    const repoRoot = findRepoRoot();

    it('runs end-to-end with existing answers', () => {
        const { projectRoot, bundleRoot } = setupTestWorkspace(repoRoot);
        try {
            const answersPath = path.join(bundleRoot, 'runtime', 'init-answers.json');
            fs.writeFileSync(answersPath, JSON.stringify({
                AssistantLanguage: 'English',
                AssistantBrevity: 'concise',
                SourceOfTruth: 'Claude',
                EnforceNoAutoCommit: 'false',
                ClaudeOrchestratorFullAccess: 'false',
                TokenEconomyEnabled: 'true',
                ProviderMinimalism: 'false',
                CollectedVia: 'CLI_NONINTERACTIVE'
            }));

            const result = runReinit({
                targetRoot: projectRoot,
                bundleRoot,
                initAnswersPath: answersPath,
                skipVerify: true,
                skipManifestValidation: true
            });

            assert.equal(result.assistantLanguage, 'English');
            assert.equal(result.sourceOfTruth, 'Claude');
            assert.equal(result.canonicalEntrypoint, 'CLAUDE.md');
            assert.ok(result.changes.length > 0);
            assert.ok(fs.existsSync(path.join(bundleRoot, 'runtime', 'protected-control-plane-manifest.json')));
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });

    it('applies overrides and writes updated answers', () => {
        const { projectRoot, bundleRoot } = setupTestWorkspace(repoRoot);
        try {
            const answersPath = path.join(bundleRoot, 'runtime', 'init-answers.json');
            fs.writeFileSync(answersPath, JSON.stringify({
                AssistantLanguage: 'English',
                AssistantBrevity: 'concise',
                SourceOfTruth: 'Claude',
                EnforceNoAutoCommit: 'false',
                ClaudeOrchestratorFullAccess: 'false',
                TokenEconomyEnabled: 'true',
                ProviderMinimalism: 'false',
                CollectedVia: 'CLI_NONINTERACTIVE'
            }));

            const result = runReinit({
                targetRoot: projectRoot,
                bundleRoot,
                initAnswersPath: answersPath,
                overrides: { AssistantLanguage: 'German', AssistantBrevity: 'detailed' },
                skipVerify: true,
                skipManifestValidation: true
            });

            assert.equal(result.assistantLanguage, 'German');
            assert.equal(result.assistantBrevity, 'detailed');

            // Verify answers were persisted
            const persistedAnswers = JSON.parse(fs.readFileSync(answersPath, 'utf8'));
            assert.equal(persistedAnswers.AssistantLanguage, 'German');
            assert.equal(persistedAnswers.AssistantBrevity, 'detailed');
            assert.equal(persistedAnswers.ProviderMinimalism, 'false');
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });

    it('updates core rule file with new language/brevity', () => {
        const { projectRoot, bundleRoot } = setupTestWorkspace(repoRoot);
        try {
            const answersPath = path.join(bundleRoot, 'runtime', 'init-answers.json');
            fs.writeFileSync(answersPath, JSON.stringify({
                AssistantLanguage: 'English',
                AssistantBrevity: 'concise',
                SourceOfTruth: 'Claude',
                EnforceNoAutoCommit: 'false',
                ClaudeOrchestratorFullAccess: 'false',
                TokenEconomyEnabled: 'true',
                CollectedVia: 'CLI_NONINTERACTIVE'
            }));

            runReinit({
                targetRoot: projectRoot,
                bundleRoot,
                initAnswersPath: answersPath,
                overrides: { AssistantLanguage: 'Spanish' },
                skipVerify: true,
                skipManifestValidation: true
            });

            const coreRule = fs.readFileSync(
                path.join(bundleRoot, 'live/docs/agent-rules/00-core.md'), 'utf8'
            );
            assert.ok(coreRule.includes('Spanish'));
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });

    it('throws when no init answers and no defaults available', () => {
        const { projectRoot, bundleRoot } = setupTestWorkspace(repoRoot);
        try {
            // Don't create any existing answers - reinit should still work with defaults
            const answersPath = path.join(bundleRoot, 'runtime', 'init-answers.json');
            // (file does not exist)

            const result = runReinit({
                targetRoot: projectRoot,
                bundleRoot,
                initAnswersPath: answersPath,
                skipVerify: true,
                skipManifestValidation: true
            });

            // Should use defaults
            assert.equal(result.assistantLanguage, 'English');
            assert.equal(result.sourceOfTruth, 'Claude');
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });

    it('preserves project-memory user content when init-answers change (T-076)', () => {
        const { projectRoot, bundleRoot } = setupTestWorkspace(repoRoot);
        try {
            const answersPath = path.join(bundleRoot, 'runtime', 'init-answers.json');
            fs.writeFileSync(answersPath, JSON.stringify({
                AssistantLanguage: 'English',
                AssistantBrevity: 'concise',
                SourceOfTruth: 'Claude',
                EnforceNoAutoCommit: 'false',
                ClaudeOrchestratorFullAccess: 'false',
                TokenEconomyEnabled: 'true',
                CollectedVia: 'CLI_NONINTERACTIVE'
            }));

            // First reinit to establish workspace
            runReinit({
                targetRoot: projectRoot,
                bundleRoot,
                initAnswersPath: answersPath,
                skipVerify: true,
                skipManifestValidation: true
            });

            // Simulate pre-existing project-memory with user content
            const pmDir = path.join(bundleRoot, 'live', 'docs', 'project-memory');
            fs.mkdirSync(pmDir, { recursive: true });
            fs.writeFileSync(path.join(pmDir, 'context.md'),
                '# Project Context\n\n## Domain\n\nFintech payment gateway.\n', 'utf8');
            fs.writeFileSync(path.join(pmDir, 'decisions.md'),
                '# Decisions\n\n## ADR-001\n\nUse event sourcing.\n', 'utf8');

            // Reinit with changed answers (language, brevity)
            const result = runReinit({
                targetRoot: projectRoot,
                bundleRoot,
                initAnswersPath: answersPath,
                overrides: { AssistantLanguage: 'German', AssistantBrevity: 'detailed' },
                skipVerify: true,
                skipManifestValidation: true
            });

            assert.equal(result.assistantLanguage, 'German');
            assert.equal(result.assistantBrevity, 'detailed');

            // project-memory must survive the reinit with changed answers
            assert.ok(fs.existsSync(path.join(pmDir, 'context.md')),
                'context.md must survive reinit with changed answers');
            assert.ok(
                fs.readFileSync(path.join(pmDir, 'context.md'), 'utf8')
                    .includes('Fintech payment gateway'),
                'user content in context.md must be intact');
            assert.ok(fs.existsSync(path.join(pmDir, 'decisions.md')),
                'decisions.md must survive reinit');
            assert.ok(
                fs.readFileSync(path.join(pmDir, 'decisions.md'), 'utf8')
                    .includes('event sourcing'),
                'user content in decisions.md must be intact');
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });

    it('preserves ActiveAgentFiles on reinit (T-047)', () => {
        const { projectRoot, bundleRoot } = setupTestWorkspace(repoRoot);
        try {
            const answersPath = path.join(bundleRoot, 'runtime', 'init-answers.json');
            fs.writeFileSync(answersPath, JSON.stringify({
                AssistantLanguage: 'English',
                AssistantBrevity: 'concise',
                SourceOfTruth: 'Claude',
                ActiveAgentFiles: 'CLAUDE.md, AGENTS.md',
                EnforceNoAutoCommit: 'false',
                ClaudeOrchestratorFullAccess: 'false',
                TokenEconomyEnabled: 'true',
                CollectedVia: 'CLI_NONINTERACTIVE'
            }));

            // Reinit changing language, should keep ActiveAgentFiles
            const result = runReinit({
                targetRoot: projectRoot,
                bundleRoot,
                initAnswersPath: answersPath,
                overrides: { AssistantLanguage: 'French' },
                skipVerify: true,
                skipManifestValidation: true
            });

            assert.equal(result.assistantLanguage, 'French');
            assert.equal(result.activeAgentFiles, 'CLAUDE.md, AGENTS.md');

            // Verify answers were persisted correctly
            const persistedAnswers = JSON.parse(fs.readFileSync(answersPath, 'utf8'));
            assert.equal(persistedAnswers.AssistantLanguage, 'French');
            assert.equal(persistedAnswers.ActiveAgentFiles, 'CLAUDE.md, AGENTS.md');
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });

    it('preserves ready agent-init checkpoints on version mismatch when answers are unchanged and cleans stale task-event locks', () => {
        const { projectRoot, bundleRoot } = setupTestWorkspace(repoRoot);
        try {
            const answersPath = path.join(bundleRoot, 'runtime', 'init-answers.json');
            const bundleVersion = fs.readFileSync(path.join(bundleRoot, 'VERSION'), 'utf8').trim();
            fs.writeFileSync(answersPath, JSON.stringify({
                AssistantLanguage: 'English',
                AssistantBrevity: 'concise',
                SourceOfTruth: 'Claude',
                EnforceNoAutoCommit: 'false',
                ClaudeOrchestratorFullAccess: 'false',
                TokenEconomyEnabled: 'true',
                CollectedVia: 'CLI_NONINTERACTIVE'
            }));
            fs.writeFileSync(path.join(bundleRoot, 'runtime', 'agent-init-state.json'), JSON.stringify({
                Version: 1,
                UpdatedAt: '2026-03-31T00:00:00.000Z',
                OrchestratorVersion: null,
                AssistantLanguage: 'English',
                SourceOfTruth: 'Claude',
                AssistantLanguageConfirmed: true,
                ActiveAgentFilesConfirmed: true,
                ProjectRulesUpdated: true,
                SkillsPromptCompleted: true,
                VerificationPassed: true,
                ManifestValidationPassed: true,
                ActiveAgentFiles: ['CLAUDE.md']
            }, null, 2), 'utf8');
            seedStaleTaskEventLock(bundleRoot, '.T-STALE.lock');

            runReinit({
                targetRoot: projectRoot,
                bundleRoot,
                initAnswersPath: answersPath,
                overrides: { ActiveAgentFiles: 'CLAUDE.md' },
                skipVerify: true,
                skipManifestValidation: true
            });

            const persistedState = JSON.parse(fs.readFileSync(
                path.join(bundleRoot, 'runtime', 'agent-init-state.json'),
                'utf8'
            ));
            assert.equal(persistedState.OrchestratorVersion, bundleVersion);
            assert.equal(persistedState.AssistantLanguageConfirmed, true);
            assert.equal(persistedState.ActiveAgentFilesConfirmed, true);
            assert.equal(persistedState.ProjectRulesUpdated, true);
            assert.equal(persistedState.SkillsPromptCompleted, true);
            assert.equal(persistedState.VerificationPassed, true);
            assert.equal(persistedState.ManifestValidationPassed, true);
            assert.ok(!fs.existsSync(path.join(bundleRoot, 'runtime', 'task-events', '.T-STALE.lock')));
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });
});

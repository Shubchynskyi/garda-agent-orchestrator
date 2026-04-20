import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import {
    SETUP_DEFINITIONS,
    getSetupAnswerDefaults,
    buildSetupHandoffText,
    buildSetupStepsText,
    handleSetup
} from '../../../../src/cli/commands/setup';
import { evaluateProtectedControlPlaneManifest } from '../../../../src/gates/helpers';
import { runVerify } from '../../../../src/validators/verify';
import type { StatusSnapshot } from '../../../../src/validators/status';

import { DEFAULT_BUNDLE_NAME, DEFAULT_INIT_ANSWERS_RELATIVE_PATH } from '../../../../src/core/constants';
import { parseOptions, getBundlePath } from '../../../../src/cli/commands/cli-helpers';

function findRepoRoot(startDir: string): string {
    let current = path.resolve(startDir);
    while (true) {
        const packageJsonPath = path.join(current, 'package.json');
        const cliPath = path.join(current, 'bin', 'garda.js');
        if (fs.existsSync(packageJsonPath) && fs.existsSync(cliPath)) {
            return current;
        }

        const parent = path.dirname(current);
        if (parent === current) {
            throw new Error(`Could not resolve repository root from: ${startDir}`);
        }
        current = parent;
    }
}

function materializeProjectCommands(bundleRoot: string): void {
    const commandsPath = path.join(bundleRoot, 'live', 'docs', 'agent-rules', '40-commands.md');
    let content = fs.readFileSync(commandsPath, 'utf8');
    const replacements = new Map([
        ['<install dependencies command>', 'npm install --prefer-offline --no-fund --no-audit'],
        ['<local environment bootstrap command>', 'npm run bootstrap'],
        ['<start backend command>', 'npm run dev:backend'],
        ['<start frontend command>', 'npm run dev:frontend'],
        ['<start worker or background job command>', 'npm run dev:worker'],
        ['<unit test command>', 'npm test'],
        ['<integration test command>', 'npm run test:integration'],
        ['<e2e test command>', 'npm run test:e2e'],
        ['<lint command>', 'npm run lint'],
        ['<type-check command>', 'npx tsc --noEmit --pretty false'],
        ['<format check command>', 'npm run format:check'],
        ['<compile command>', 'npm run build'],
        ['<build command>', 'npm run build'],
        ['<container or artifact packaging command>', 'docker build .']
    ]);

    for (const [placeholder, replacement] of replacements) {
        content = content.replaceAll(placeholder, replacement);
    }

    fs.writeFileSync(commandsPath, content, 'utf8');
}

// ---------------------------------------------------------------------------
// SETUP_DEFINITIONS
// ---------------------------------------------------------------------------

test('SETUP_DEFINITIONS includes all expected flags', () => {
    assert.ok(SETUP_DEFINITIONS['--target-root']);
    assert.ok(SETUP_DEFINITIONS['--init-answers-path']);
    assert.ok(SETUP_DEFINITIONS['--repo-url']);
    assert.ok(SETUP_DEFINITIONS['--branch']);
    assert.ok(SETUP_DEFINITIONS['--dry-run']);
    assert.equal(SETUP_DEFINITIONS['--dry-run'].type, 'boolean');
    assert.ok(SETUP_DEFINITIONS['--no-prompt']);
    assert.ok(SETUP_DEFINITIONS['--skip-verify']);
    assert.ok(SETUP_DEFINITIONS['--skip-manifest-validation']);
    assert.ok(SETUP_DEFINITIONS['--preserve-agent-state']);
    assert.ok(SETUP_DEFINITIONS['--assistant-language']);
    assert.ok(SETUP_DEFINITIONS['--assistant-brevity']);
    assert.ok(SETUP_DEFINITIONS['--active-agent-files']);
    assert.ok(SETUP_DEFINITIONS['--source-of-truth']);
    assert.ok(SETUP_DEFINITIONS['--enforce-no-auto-commit']);
    assert.ok(SETUP_DEFINITIONS['--claude-orchestrator-full-access']);
    assert.ok(SETUP_DEFINITIONS['--claude-full-access']);
    assert.equal(SETUP_DEFINITIONS['--claude-full-access'].key, 'claudeOrchestratorFullAccess');
    assert.ok(SETUP_DEFINITIONS['--token-economy-enabled']);
    assert.ok(SETUP_DEFINITIONS['--provider-minimalism']);
});

test('parseOptions works with SETUP_DEFINITIONS', () => {
    const { options } = parseOptions([
        '--target-root', '/workspace',
        '--no-prompt',
        '--preserve-agent-state',
        '--source-of-truth', 'Claude',
        '--assistant-language', 'English',
        '--assistant-brevity', 'concise',
        '--enforce-no-auto-commit', 'true',
        '--token-economy-enabled', 'false',
        '--provider-minimalism', 'false'
    ], SETUP_DEFINITIONS);

    assert.equal(options.targetRoot, '/workspace');
    assert.equal(options.noPrompt, true);
    assert.equal(options.preserveAgentState, true);
    assert.equal(options.sourceOfTruth, 'Claude');
    assert.equal(options.assistantLanguage, 'English');
    assert.equal(options.assistantBrevity, 'concise');
    assert.equal(options.enforceNoAutoCommit, 'true');
    assert.equal(options.tokenEconomyEnabled, 'false');
    assert.equal(options.providerMinimalism, 'false');
});

test('--claude-full-access aliases to claudeOrchestratorFullAccess', () => {
    const { options } = parseOptions(['--claude-full-access', 'yes'], SETUP_DEFINITIONS);
    assert.equal(options.claudeOrchestratorFullAccess, 'yes');
});

// ---------------------------------------------------------------------------
// getSetupAnswerDefaults
// ---------------------------------------------------------------------------

test('getSetupAnswerDefaults returns sensible defaults for empty workspace', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-defaults-'));
    try {
        const defaults = getSetupAnswerDefaults(tmpDir, DEFAULT_INIT_ANSWERS_RELATIVE_PATH, {});
        assert.equal(defaults.assistantLanguage, 'English');
        assert.equal(defaults.assistantBrevity, 'concise');
        assert.equal(defaults.sourceOfTruth, 'Claude');
        assert.equal(defaults.enforceNoAutoCommit, true);
        assert.equal(defaults.claudeOrchestratorFullAccess, false);
        assert.equal(defaults.tokenEconomyEnabled, true);
        assert.equal(defaults.providerMinimalism, true);
        assert.equal(defaults.activeAgentFiles, 'CLAUDE.md');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('getSetupAnswerDefaults respects CLI options over defaults', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-defaults-'));
    try {
        const defaults = getSetupAnswerDefaults(tmpDir, DEFAULT_INIT_ANSWERS_RELATIVE_PATH, {
            assistantLanguage: 'Russian',
            assistantBrevity: 'detailed',
            sourceOfTruth: 'Codex',
            enforceNoAutoCommit: 'false',
            claudeOrchestratorFullAccess: 'true',
            tokenEconomyEnabled: 'false',
            providerMinimalism: 'false'
        });
        assert.equal(defaults.assistantLanguage, 'Russian');
        assert.equal(defaults.assistantBrevity, 'detailed');
        assert.equal(defaults.sourceOfTruth, 'Codex');
        assert.equal(defaults.enforceNoAutoCommit, false);
        assert.equal(defaults.claudeOrchestratorFullAccess, true);
        assert.equal(defaults.tokenEconomyEnabled, false);
        assert.equal(defaults.providerMinimalism, false);
        assert.equal(defaults.activeAgentFiles, 'AGENTS.md');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('getSetupAnswerDefaults reads existing init answers file', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-defaults-'));
    const answersDir = path.join(tmpDir, DEFAULT_BUNDLE_NAME, 'runtime');
    fs.mkdirSync(answersDir, { recursive: true });
    fs.writeFileSync(
        path.join(answersDir, 'init-answers.json'),
        JSON.stringify({
            AssistantLanguage: 'Deutsch',
            AssistantBrevity: 'detailed',
            SourceOfTruth: 'Gemini',
            EnforceNoAutoCommit: 'true',
            ClaudeOrchestratorFullAccess: 'true',
            TokenEconomyEnabled: 'false',
            ProviderMinimalism: 'false'
        }),
        'utf8'
    );

    try {
        const defaults = getSetupAnswerDefaults(tmpDir, DEFAULT_INIT_ANSWERS_RELATIVE_PATH, {});
        assert.equal(defaults.assistantLanguage, 'Deutsch');
        assert.equal(defaults.assistantBrevity, 'detailed');
        assert.equal(defaults.sourceOfTruth, 'Gemini');
        assert.equal(defaults.enforceNoAutoCommit, true);
        assert.equal(defaults.claudeOrchestratorFullAccess, true);
        assert.equal(defaults.tokenEconomyEnabled, false);
        assert.equal(defaults.providerMinimalism, false);
        assert.equal(defaults.activeAgentFiles, 'GEMINI.md');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('getSetupAnswerDefaults CLI options override existing init answers', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-defaults-'));
    const answersDir = path.join(tmpDir, DEFAULT_BUNDLE_NAME, 'runtime');
    fs.mkdirSync(answersDir, { recursive: true });
    fs.writeFileSync(
        path.join(answersDir, 'init-answers.json'),
        JSON.stringify({
            AssistantLanguage: 'Deutsch',
            AssistantBrevity: 'detailed',
            SourceOfTruth: 'Gemini',
            EnforceNoAutoCommit: 'true',
            ClaudeOrchestratorFullAccess: 'false',
            TokenEconomyEnabled: 'true'
        }),
        'utf8'
    );

    try {
        const defaults = getSetupAnswerDefaults(tmpDir, DEFAULT_INIT_ANSWERS_RELATIVE_PATH, {
            sourceOfTruth: 'Claude'
        });
        assert.equal(defaults.assistantLanguage, 'Deutsch');
        assert.equal(defaults.sourceOfTruth, 'Claude');
        assert.equal(defaults.activeAgentFiles, 'CLAUDE.md');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('getSetupAnswerDefaults normalizes numbered active agent file selections', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-defaults-'));
    try {
        const defaults = getSetupAnswerDefaults(tmpDir, DEFAULT_INIT_ANSWERS_RELATIVE_PATH, {
            sourceOfTruth: 'Claude',
            activeAgentFiles: '1, 2, 8'
        });
        assert.equal(defaults.activeAgentFiles, 'CLAUDE.md, AGENTS.md, .antigravity/rules.md');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('getSetupAnswerDefaults preserves existing active agent files by default', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-defaults-'));
    const answersDir = path.join(tmpDir, DEFAULT_BUNDLE_NAME, 'runtime');
    fs.mkdirSync(answersDir, { recursive: true });
    fs.writeFileSync(
        path.join(answersDir, 'init-answers.json'),
        JSON.stringify({
            AssistantLanguage: 'English',
            AssistantBrevity: 'concise',
            SourceOfTruth: 'Codex',
            EnforceNoAutoCommit: 'true',
            ClaudeOrchestratorFullAccess: 'false',
            TokenEconomyEnabled: 'true',
            ActiveAgentFiles: 'CLAUDE.md, AGENTS.md'
        }),
        'utf8'
    );

    try {
        const defaults = getSetupAnswerDefaults(tmpDir, DEFAULT_INIT_ANSWERS_RELATIVE_PATH, {});
        assert.equal(defaults.sourceOfTruth, 'Codex');
        assert.equal(defaults.activeAgentFiles, 'CLAUDE.md, AGENTS.md');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('getSetupAnswerDefaults reconciles preserved active agent files with an explicit source-of-truth override', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-defaults-'));
    const answersDir = path.join(tmpDir, DEFAULT_BUNDLE_NAME, 'runtime');
    fs.mkdirSync(answersDir, { recursive: true });
    fs.writeFileSync(
        path.join(answersDir, 'init-answers.json'),
        JSON.stringify({
            AssistantLanguage: 'English',
            AssistantBrevity: 'concise',
            SourceOfTruth: 'Codex',
            EnforceNoAutoCommit: 'true',
            ClaudeOrchestratorFullAccess: 'false',
            TokenEconomyEnabled: 'true',
            ActiveAgentFiles: 'CLAUDE.md, AGENTS.md, .antigravity/rules.md'
        }),
        'utf8'
    );

    try {
        const defaults = getSetupAnswerDefaults(tmpDir, DEFAULT_INIT_ANSWERS_RELATIVE_PATH, {
            sourceOfTruth: 'Gemini'
        });
        assert.equal(defaults.sourceOfTruth, 'Gemini');
        assert.equal(defaults.activeAgentFiles, 'CLAUDE.md, AGENTS.md, GEMINI.md, .antigravity/rules.md');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('handleSetup --no-prompt preserves existing active agent files and rematerializes their entrypoints', async () => {
    const repoRoot = findRepoRoot(__dirname);
    const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-setup-preserve-active-files-'));
    const answersDir = path.join(workspaceRoot, DEFAULT_BUNDLE_NAME, 'runtime');
    fs.mkdirSync(answersDir, { recursive: true });
    fs.writeFileSync(
        path.join(answersDir, 'init-answers.json'),
        JSON.stringify({
            AssistantLanguage: 'English',
            AssistantBrevity: 'concise',
            SourceOfTruth: 'Codex',
            EnforceNoAutoCommit: 'false',
            ClaudeOrchestratorFullAccess: 'false',
            TokenEconomyEnabled: 'true',
            ProviderMinimalism: 'false',
            CollectedVia: 'CLI_NONINTERACTIVE',
            ActiveAgentFiles: 'CLAUDE.md, AGENTS.md, .antigravity/rules.md'
        }),
        'utf8'
    );

    try {
        await handleSetup(
            ['--target-root', workspaceRoot, '--no-prompt', '--skip-verify', '--skip-manifest-validation'],
            packageJson,
            repoRoot
        );

        const persistedAnswers = JSON.parse(
            fs.readFileSync(path.join(workspaceRoot, DEFAULT_BUNDLE_NAME, 'runtime', 'init-answers.json'), 'utf8')
        );
        assert.equal(persistedAnswers.ActiveAgentFiles, 'CLAUDE.md, AGENTS.md, .antigravity/rules.md');
        assert.equal(persistedAnswers.ProviderMinimalism, 'false');
        assert.ok(fs.existsSync(path.join(workspaceRoot, 'CLAUDE.md')));
        assert.ok(fs.existsSync(path.join(workspaceRoot, 'AGENTS.md')));
        assert.ok(fs.existsSync(path.join(workspaceRoot, '.antigravity', 'rules.md')));
    } finally {
        fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
});

test('handleSetup runs contract migrations before verify so stale live task workflow snippets do not block refresh', async () => {
    const repoRoot = findRepoRoot(__dirname);
    const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-setup-contract-migrations-'));
    const bundleRoot = path.join(workspaceRoot, DEFAULT_BUNDLE_NAME);
    const staleWorkflowPath = path.join(bundleRoot, 'live', 'docs', 'agent-rules', '80-task-workflow.md');
    const taskAuditSnippet = 'gate task-audit-summary --task-id "<task-id>" --as-json';

    try {
        fs.mkdirSync(path.join(workspaceRoot, '.git'), { recursive: true });

        await handleSetup(
            ['--target-root', workspaceRoot, '--no-prompt', '--skip-verify', '--skip-manifest-validation', '--source-of-truth', 'Codex'],
            packageJson,
            repoRoot
        );

        materializeProjectCommands(bundleRoot);
        const staleWorkflow = fs.readFileSync(staleWorkflowPath, 'utf8')
            .replace(/^.*gate task-audit-summary --task-id "<task-id>" --as-json.*\r?\n?/gm, '');
        fs.writeFileSync(staleWorkflowPath, staleWorkflow, 'utf8');
        assert.ok(!fs.readFileSync(staleWorkflowPath, 'utf8').includes(taskAuditSnippet));

        await handleSetup(
            ['--target-root', workspaceRoot, '--no-prompt', '--verify', '--skip-manifest-validation', '--preserve-agent-state'],
            packageJson,
            repoRoot
        );

        const refreshedWorkflow = fs.readFileSync(staleWorkflowPath, 'utf8');
        assert.ok(refreshedWorkflow.includes(taskAuditSnippet));

        const verifyResult = runVerify({
            targetRoot: workspaceRoot,
            sourceOfTruth: 'Codex',
            initAnswersPath: path.join(DEFAULT_BUNDLE_NAME, 'runtime', 'init-answers.json')
        });
        assert.equal(verifyResult.passed, true, JSON.stringify(verifyResult.violations));

        const protectedManifestEvidence = evaluateProtectedControlPlaneManifest(workspaceRoot, null, true);
        assert.equal(protectedManifestEvidence.status, 'MATCH', JSON.stringify(protectedManifestEvidence));
    } finally {
        fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// buildSetupHandoffText
// ---------------------------------------------------------------------------

test('buildSetupHandoffText includes agent initialization section', () => {
    const snapshot = {
        bundlePath: '/workspace/garda-agent-orchestrator',
        activeAgentFiles: 'CLAUDE.md, AGENTS.md'
    };
    const text = buildSetupHandoffText(snapshot as unknown as StatusSnapshot);
    assert.ok(text.includes('Agent Initialization'));
    assert.ok(text.includes('Primary setup is complete'));
    assert.ok(text.includes('Next stage: launch your agent'));
    assert.ok(text.includes('CLAUDE.md, AGENTS.md'));
    assert.ok(text.includes('AGENT_INIT_PROMPT.md'));
    assert.ok(text.includes('Execute task T-001 from TASK.md strictly through all mandatory orchestrator gates.'));
    assert.ok(text.includes('Use explicit depth only as a one-run override.'));
    assert.ok(text.includes('start banner'));
    assert.ok(text.includes('Garda captures my mind'));
    assert.ok(text.includes('Mandatory orchestrator flow:'));
    assert.ok(text.includes('enter-task-mode -> load-rule-pack -> handshake-diagnostics -> shell-smoke-preflight -> classify-change -> load-rule-pack -> compile-gate -> build-review-context (for each required review) -> required-reviews-check -> doc-impact-gate -> full-suite-validation (when enabled) -> completion-gate'));
});

test('buildSetupHandoffText reports the active profile and default depth', () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-handoff-profile-'));
    try {
        const bundlePath = path.join(workspace, 'garda-agent-orchestrator');
        const profilesPath = path.join(bundlePath, 'live', 'config', 'profiles.json');
        fs.mkdirSync(path.dirname(profilesPath), { recursive: true });
        fs.writeFileSync(
            profilesPath,
            JSON.stringify({
                version: 1,
                active_profile: 'strict',
                built_in_profiles: {
                    strict: {
                        description: 'Strict profile',
                        depth: 3,
                        review_policy: {},
                        token_economy: {
                            enabled: true,
                            strip_examples: true,
                            strip_code_blocks: true,
                            scoped_diffs: true,
                            compact_reviewer_output: true
                        },
                        skills: {}
                    }
                },
                user_profiles: {}
            }, null, 2),
            'utf8'
        );

        const text = buildSetupHandoffText({
            bundlePath,
            activeAgentFiles: 'CLAUDE.md'
        } as unknown as StatusSnapshot);
        assert.ok(text.includes('Current active profile: strict (default depth=3).'));
    } finally {
        fs.rmSync(workspace, { recursive: true, force: true });
    }
});

test('buildSetupHandoffText omits active agent files when null', () => {
    const snapshot = {
        bundlePath: '/workspace/garda-agent-orchestrator',
        activeAgentFiles: null
    };
    const text = buildSetupHandoffText(snapshot as unknown as StatusSnapshot);
    assert.ok(!text.includes('Active agent files'));
    assert.ok(text.includes('Agent Initialization'));
});

// ---------------------------------------------------------------------------
// buildSetupStepsText
// ---------------------------------------------------------------------------

test('buildSetupStepsText includes step markers for interactive', () => {
    const text = buildSetupStepsText('/workspace', true, true);
    assert.ok(text.includes('You will be asked 6 control questions'));
    assert.ok(text.includes('[1/3] Deploy bundle'));
    assert.ok(text.includes('[2/3] Collect or reuse init answers'));
    assert.ok(text.includes('[3/3] Run install and prepare agent handoff'));
});

test('buildSetupStepsText shows non-interactive message for no-prompt', () => {
    const text = buildSetupStepsText('/workspace', false, false);
    assert.ok(text.includes('Running in non-interactive mode'));
});

test('buildSetupStepsText shows fallback message for non-TTY interactive', () => {
    const text = buildSetupStepsText('/workspace', false, true);
    assert.ok(text.includes('Interactive prompts are unavailable'));
});

test('buildSetupStepsText includes project path', () => {
    const text = buildSetupStepsText('/workspace', true, true);
    assert.ok(text.includes('Project: /workspace'));
});

test('buildSetupStepsText includes bundle path', () => {
    const text = buildSetupStepsText('/workspace', true, true);
    assert.ok(text.includes('BundlePath:'));
});

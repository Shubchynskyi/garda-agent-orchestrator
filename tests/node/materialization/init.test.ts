import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import { runInit, mergeConfig } from '../../../src/materialization/init';
import { getLifecycleOperationLockPath } from '../../../src/lifecycle/common';

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
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-init-'));
    const bundle = path.join(tmpDir, 'garda-agent-orchestrator');
    fs.mkdirSync(bundle, { recursive: true });
    fs.copyFileSync(path.join(bundleRoot, 'VERSION'), path.join(bundle, 'VERSION'));
    copyDirRecursive(path.join(bundleRoot, 'template'), path.join(bundle, 'template'));
    fs.mkdirSync(path.join(bundle, 'runtime'), { recursive: true });
    fs.mkdirSync(path.join(bundle, 'live'), { recursive: true });
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

function seedLifecycleOperationLock(projectRoot: string, pid: number, hostname: string = os.hostname()) {
    const lockPath = getLifecycleOperationLockPath(projectRoot);
    fs.mkdirSync(lockPath, { recursive: true });
    fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
        pid,
        hostname,
        operation: 'update',
        acquired_at_utc: '2026-04-06T00:00:00.000Z',
        target_root: path.resolve(projectRoot)
    }, null, 2), 'utf8');
    return lockPath;
}

describe('runInit', () => {
    const repoRoot = findRepoRoot();

    it('materializes all 12 rule files in live/docs/agent-rules', () => {
        const { projectRoot, bundleRoot } = setupTestWorkspace(repoRoot);
        try {
            const result = runInit({
                targetRoot: projectRoot,
                bundleRoot,
                assistantLanguage: 'English',
                assistantBrevity: 'concise',
                sourceOfTruth: 'Claude'
            });

            assert.equal(result.ruleFilesMaterialized, 12);
            assert.ok(fs.existsSync(path.join(bundleRoot, 'live/docs/agent-rules/00-core.md')));
            assert.ok(fs.existsSync(path.join(bundleRoot, 'live/docs/agent-rules/15-project-memory.md')));
            assert.ok(fs.existsSync(path.join(bundleRoot, 'live/docs/agent-rules/80-task-workflow.md')));
            assert.ok(fs.existsSync(path.join(bundleRoot, 'live/docs/agent-rules/90-skill-catalog.md')));
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });

    it('applies language and brevity to 00-core.md', () => {
        const { projectRoot, bundleRoot } = setupTestWorkspace(repoRoot);
        try {
            runInit({
                targetRoot: projectRoot,
                bundleRoot,
                assistantLanguage: 'Russian',
                assistantBrevity: 'detailed',
                sourceOfTruth: 'Claude'
            });

            const coreContent = fs.readFileSync(
                path.join(bundleRoot, 'live/docs/agent-rules/00-core.md'), 'utf8'
            );
            assert.ok(coreContent.includes('Russian'));
            assert.ok(coreContent.includes('detailed'));
            assert.ok(!coreContent.includes('{{ASSISTANT_RESPONSE_LANGUAGE}}'));
            assert.ok(!coreContent.includes('{{ASSISTANT_RESPONSE_BREVITY}}'));
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });

    it('copies support directories to live/', () => {
        const { projectRoot, bundleRoot } = setupTestWorkspace(repoRoot);
        try {
            const result = runInit({
                targetRoot: projectRoot,
                bundleRoot,
                assistantLanguage: 'English',
                assistantBrevity: 'concise',
                sourceOfTruth: 'Claude'
            });

            assert.ok(result.supportDirectoriesSynced > 0);
            assert.ok(fs.existsSync(path.join(bundleRoot, 'live/config')));
            assert.ok(fs.existsSync(path.join(bundleRoot, 'live/skills')));
            assert.ok(fs.existsSync(path.join(bundleRoot, 'live/skills/orchestration/skill.json')));
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });

    it('creates reporting files', () => {
        const { projectRoot, bundleRoot } = setupTestWorkspace(repoRoot);
        try {
            fs.mkdirSync(path.join(projectRoot, 'docs', 'agent-rules'), { recursive: true });
            fs.writeFileSync(path.join(projectRoot, 'AGENTS.md'), '# Legacy\n', 'utf8');
            fs.writeFileSync(path.join(projectRoot, 'docs', 'agent-rules', '10-context.md'), '# Context\n', 'utf8');
            fs.writeFileSync(path.join(projectRoot, 'docs', 'overview.md'), '# Overview\n', 'utf8');

            const result = runInit({
                targetRoot: projectRoot,
                bundleRoot,
                assistantLanguage: 'English',
                assistantBrevity: 'concise',
                sourceOfTruth: 'Claude'
            });

            assert.ok(fs.existsSync(result.initReportPath));
            assert.ok(fs.existsSync(result.sourceInventoryPath));
            assert.ok(fs.existsSync(result.projectDiscoveryPath));
            assert.ok(fs.existsSync(result.usagePath));

            const report = fs.readFileSync(result.initReportPath, 'utf8');
            const inventory = fs.readFileSync(result.sourceInventoryPath, 'utf8');
            const discovery = fs.readFileSync(result.projectDiscoveryPath, 'utf8');
            assert.ok(report.includes('# Init Report'));
            assert.ok(report.includes('Rule Source Mapping'));
            assert.ok(report.includes('Legacy docs discovered in `docs/agent-rules`: 1 files'));
            assert.ok(inventory.includes('`AGENTS.md` : FOUND'));
            assert.ok(inventory.includes('`docs/agent-rules` : FOUND (files=1)'));
            assert.ok(discovery.includes('## Stack Evidence'));
            assert.ok(discovery.includes('## Runtime Path Hints'));
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });

    it('sets token economy enabled flag in config', () => {
        const { projectRoot, bundleRoot } = setupTestWorkspace(repoRoot);
        try {
            runInit({
                targetRoot: projectRoot,
                bundleRoot,
                assistantLanguage: 'English',
                assistantBrevity: 'concise',
                sourceOfTruth: 'Claude',
                tokenEconomyEnabled: false
            });

            const configPath = path.join(bundleRoot, 'live/config/token-economy.json');
            assert.ok(fs.existsSync(configPath));
            const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            assert.equal(config.enabled, false);
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });

    it('materializes code_first_optional review_execution_policy for a fresh bundle', () => {
        const { projectRoot, bundleRoot } = setupTestWorkspace(repoRoot);
        try {
            runInit({
                targetRoot: projectRoot,
                bundleRoot,
                assistantLanguage: 'English',
                assistantBrevity: 'concise',
                sourceOfTruth: 'Claude'
            });

            const workflowConfig = JSON.parse(fs.readFileSync(
                path.join(bundleRoot, 'live', 'config', 'workflow-config.json'),
                'utf8'
            ));
            assert.deepEqual(workflowConfig.review_execution_policy, {
                mode: 'code_first_optional'
            });
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });

    it('syncs root .gitignore and includes .review-temp during standalone init', () => {
        const { projectRoot, bundleRoot } = setupTestWorkspace(repoRoot);
        try {
            runInit({
                targetRoot: projectRoot,
                bundleRoot,
                assistantLanguage: 'English',
                assistantBrevity: 'concise',
                sourceOfTruth: 'Claude'
            });

            const gitignore = fs.readFileSync(path.join(projectRoot, '.gitignore'), 'utf8');
            assert.ok(gitignore.includes('# garda-agent-orchestrator managed ignores'));
            assert.ok(gitignore.includes('garda-agent-orchestrator/'));
            assert.ok(gitignore.includes('TASK.md'));
            assert.ok(gitignore.includes('.review-temp/'));
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });

    it('rewrites garda.config.json from the canonical template on reinit', () => {
        const { projectRoot, bundleRoot } = setupTestWorkspace(repoRoot);
        try {
            runInit({
                targetRoot: projectRoot,
                bundleRoot,
                assistantLanguage: 'English',
                assistantBrevity: 'concise',
                sourceOfTruth: 'Claude'
            });

            const gardaConfigPath = path.join(bundleRoot, 'live', 'config', 'garda.config.json');
            const templateConfigPath = path.join(bundleRoot, 'template', 'config', 'garda.config.json');
            const modifiedConfig = {
                version: 99,
                configs: {
                    'review-capabilities': '../custom/review-capabilities.json',
                    'token-economy': 'token-economy.json'
                },
                custom: true
            };

            fs.writeFileSync(gardaConfigPath, JSON.stringify(modifiedConfig, null, 2), 'utf8');

            const result = runInit({
                targetRoot: projectRoot,
                bundleRoot,
                assistantLanguage: 'English',
                assistantBrevity: 'concise',
                sourceOfTruth: 'Claude'
            });

            const materializedConfig = JSON.parse(fs.readFileSync(gardaConfigPath, 'utf8'));
            const templateConfig = JSON.parse(fs.readFileSync(templateConfigPath, 'utf8'));
            assert.deepEqual(materializedConfig, templateConfig);
            assert.equal(result.gardaConfigMergeStatus, 'canonical_template_reapplied_existing_values_replaced');

            const report = fs.readFileSync(result.initReportPath, 'utf8');
            assert.ok(report.includes('Root config manifest sync policy: rewrite the canonical root manifest from template on every init/update.'));
            assert.ok(report.includes('Root config manifest merge status: canonical_template_reapplied_existing_values_replaced'));
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });

    it('fails when another live lifecycle operation lock exists', () => {
        const { projectRoot, bundleRoot } = setupTestWorkspace(repoRoot);
        try {
            const lockPath = seedLifecycleOperationLock(projectRoot, process.pid);

            assert.throws(() => runInit({
                targetRoot: projectRoot,
                bundleRoot,
                assistantLanguage: 'English',
                assistantBrevity: 'concise',
                sourceOfTruth: 'Claude'
            }), /Another lifecycle operation is already running/);
            assert.ok(fs.existsSync(lockPath), 'live lock must be preserved');
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });

    it('reclaims stale lifecycle operation lock before init', () => {
        const { projectRoot, bundleRoot } = setupTestWorkspace(repoRoot);
        try {
            const lockPath = seedLifecycleOperationLock(projectRoot, 99999999);

            const result = runInit({
                targetRoot: projectRoot,
                bundleRoot,
                assistantLanguage: 'English',
                assistantBrevity: 'concise',
                sourceOfTruth: 'Claude'
            });

            assert.equal(result.ruleFilesMaterialized, 12);
            assert.ok(!fs.existsSync(lockPath), 'stale lock should be removed after successful init');
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });

    it('throws for unsupported brevity', () => {
        const { projectRoot, bundleRoot } = setupTestWorkspace(repoRoot);
        try {
            assert.throws(() => runInit({
                targetRoot: projectRoot,
                bundleRoot,
                assistantBrevity: 'invalid'
            }), /Unsupported AssistantBrevity/);
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });

    it('seeds USAGE.md with canonical entrypoint', () => {
        const { projectRoot, bundleRoot } = setupTestWorkspace(repoRoot);
        try {
            runInit({
                targetRoot: projectRoot,
                bundleRoot,
                assistantLanguage: 'English',
                assistantBrevity: 'concise',
                sourceOfTruth: 'Codex'
            });

            const usage = fs.readFileSync(path.join(bundleRoot, 'live/USAGE.md'), 'utf8');
            assert.ok(usage.includes('AGENTS.md'));
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });

    it('renders profile-first task execution guidance in USAGE.md', () => {
        const { projectRoot, bundleRoot } = setupTestWorkspace(repoRoot);
        try {
            runInit({
                targetRoot: projectRoot,
                bundleRoot,
                assistantLanguage: 'English',
                assistantBrevity: 'concise',
                sourceOfTruth: 'Codex'
            });

            const usage = fs.readFileSync(path.join(bundleRoot, 'live/USAGE.md'), 'utf8');
            assert.ok(usage.includes('Execute task <task-id> from TASK.md strictly through all mandatory orchestrator gates.'));
            assert.ok(
                usage.includes(
                    'The command automatically runs mandatory orchestration gates in order: `enter-task-mode`, `load-rule-pack`, `handshake-diagnostics`, `shell-smoke-preflight`, `classify-change`, `load-rule-pack`, `compile-gate`, `build-review-context` (for each required review), `required-reviews-check`, `doc-impact-gate`, `completion-gate`.'
                )
            );
            assert.ok(usage.includes('Require the first fresh main-agent execution reply to emit exactly one English start banner'));
            assert.ok(usage.includes('Garda captures my mind'));
            assert.ok(
                usage.includes(
                    'Default execution comes from the active profile. Built-in profiles: `balanced` (depth `2`), `fast` (depth `1`), `strict` (depth `3`), `docs-only` (depth `1`).'
                )
            );
            assert.ok(usage.includes('Use `depth=<1|2|3>` only when you intentionally want a one-run override of the selected profile.'));
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });

    it('synchronizes optional review capabilities from live specialist skills', () => {
        const { projectRoot, bundleRoot } = setupTestWorkspace(repoRoot);
        try {
            const apiSkillRoot = path.join(bundleRoot, 'live', 'skills', 'api-contract-review');
            const testSkillRoot = path.join(bundleRoot, 'live', 'skills', 'testing-strategy');
            fs.mkdirSync(apiSkillRoot, { recursive: true });
            fs.mkdirSync(testSkillRoot, { recursive: true });
            fs.writeFileSync(path.join(apiSkillRoot, 'SKILL.md'), '# api-contract-review\n', 'utf8');
            fs.writeFileSync(path.join(testSkillRoot, 'SKILL.md'), '# testing-strategy\n', 'utf8');

            runInit({
                targetRoot: projectRoot,
                bundleRoot,
                assistantLanguage: 'English',
                assistantBrevity: 'concise',
                sourceOfTruth: 'Claude'
            });

            const capabilities = JSON.parse(fs.readFileSync(
                path.join(bundleRoot, 'live', 'config', 'review-capabilities.json'),
                'utf8'
            ));
            assert.equal(capabilities.api, true);
            assert.equal(capabilities.test, true);
            assert.equal(capabilities.dependency, true);
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });

    it('seeds project-memory from template on first install (T-072)', () => {
        const { projectRoot, bundleRoot } = setupTestWorkspace(repoRoot);
        try {
            const result = runInit({
                targetRoot: projectRoot,
                bundleRoot,
                assistantLanguage: 'English',
                assistantBrevity: 'concise',
                sourceOfTruth: 'Claude'
            });

            const pmDir = path.join(bundleRoot, 'live', 'docs', 'project-memory');
            assert.ok(fs.existsSync(pmDir), 'project-memory should be seeded from template on first install');
            assert.ok(fs.existsSync(path.join(pmDir, 'README.md')), 'project-memory/README.md should exist');
            assert.equal(result.seedOnlyDirectoriesSeeded, 1);
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });

    it('preserves existing project-memory on reinit (T-072)', () => {
        const { projectRoot, bundleRoot } = setupTestWorkspace(repoRoot);
        try {
            // First init — seeds project-memory
            runInit({
                targetRoot: projectRoot,
                bundleRoot,
                assistantLanguage: 'English',
                assistantBrevity: 'concise',
                sourceOfTruth: 'Claude'
            });

            // Write user content into project-memory
            const pmDir = path.join(bundleRoot, 'live', 'docs', 'project-memory');
            fs.writeFileSync(path.join(pmDir, 'user-notes.md'), '# User Notes\nImportant decision.');

            // Second init (simulating reinit/update)
            const result2 = runInit({
                targetRoot: projectRoot,
                bundleRoot,
                assistantLanguage: 'English',
                assistantBrevity: 'concise',
                sourceOfTruth: 'Claude'
            });

            // User content must survive
            assert.ok(fs.existsSync(path.join(pmDir, 'user-notes.md')),
                'user-notes.md must survive reinit');
            assert.equal(
                fs.readFileSync(path.join(pmDir, 'user-notes.md'), 'utf8'),
                '# User Notes\nImportant decision.'
            );
            assert.equal(result2.seedOnlyDirectoriesSeeded, 0,
                'project-memory should not be re-seeded when already present');
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });

    it('does not collaterally affect project-memory via docs support directory sync (T-072)', () => {
        const { projectRoot, bundleRoot } = setupTestWorkspace(repoRoot);
        try {
            // First init
            runInit({
                targetRoot: projectRoot,
                bundleRoot,
                assistantLanguage: 'English',
                assistantBrevity: 'concise',
                sourceOfTruth: 'Claude'
            });

            // Add user file in project-memory
            const pmDir = path.join(bundleRoot, 'live', 'docs', 'project-memory');
            fs.writeFileSync(path.join(pmDir, 'custom.md'), 'custom');

            // Second init — support dirs (docs/changes, docs/reviews, docs/tasks) get re-synced
            runInit({
                targetRoot: projectRoot,
                bundleRoot,
                assistantLanguage: 'English',
                assistantBrevity: 'concise',
                sourceOfTruth: 'Claude'
            });

            // project-memory/custom.md must still be there
            assert.ok(fs.existsSync(path.join(pmDir, 'custom.md')),
                'docs/project-memory must not be affected by docs/* support directory sync');
            assert.equal(fs.readFileSync(path.join(pmDir, 'custom.md'), 'utf8'), 'custom');
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });

    it('generates 15-project-memory.md with DO NOT EDIT header on init (T-073)', () => {
        const { projectRoot, bundleRoot } = setupTestWorkspace(repoRoot);
        try {
            runInit({
                targetRoot: projectRoot,
                bundleRoot,
                assistantLanguage: 'English',
                assistantBrevity: 'concise',
                sourceOfTruth: 'Claude'
            });

            const summaryPath = path.join(bundleRoot, 'live', 'docs', 'agent-rules', '15-project-memory.md');
            assert.ok(fs.existsSync(summaryPath), '15-project-memory.md must exist after init');
            const content = fs.readFileSync(summaryPath, 'utf8');
            assert.ok(content.includes('DO NOT EDIT'), 'must have DO NOT EDIT header');
            assert.ok(content.includes('15 · Project Memory Summary'), 'must have title');
            assert.ok(content.includes('Generated at:'), 'must have timestamp');
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });

    it('regenerates 15-project-memory.md with user content on reinit (T-073)', () => {
        const { projectRoot, bundleRoot } = setupTestWorkspace(repoRoot);
        try {
            // First init — seeds template project-memory
            runInit({
                targetRoot: projectRoot,
                bundleRoot,
                assistantLanguage: 'English',
                assistantBrevity: 'concise',
                sourceOfTruth: 'Claude'
            });

            // Add real content to project-memory
            const pmDir = path.join(bundleRoot, 'live', 'docs', 'project-memory');
            fs.writeFileSync(path.join(pmDir, 'context.md'),
                '# Context\n\n## Domain\n\nB2B logistics SaaS.\n', 'utf8');

            // Second init (reinit)
            runInit({
                targetRoot: projectRoot,
                bundleRoot,
                assistantLanguage: 'English',
                assistantBrevity: 'concise',
                sourceOfTruth: 'Claude'
            });

            const content = fs.readFileSync(
                path.join(bundleRoot, 'live', 'docs', 'agent-rules', '15-project-memory.md'), 'utf8'
            );
            assert.ok(content.includes('B2B logistics SaaS'), 'summary must contain user content');
            assert.ok(content.includes('Provenance'), 'summary must include provenance table');
            assert.ok(content.includes('docs/project-memory/context.md'), 'provenance must reference source');
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });

    it('generates placeholder stub when project-memory has only templates (T-073)', () => {
        const { projectRoot, bundleRoot } = setupTestWorkspace(repoRoot);
        try {
            // Init seeds template files which have only HTML comment placeholders
            runInit({
                targetRoot: projectRoot,
                bundleRoot,
                assistantLanguage: 'English',
                assistantBrevity: 'concise',
                sourceOfTruth: 'Claude'
            });

            const content = fs.readFileSync(
                path.join(bundleRoot, 'live', 'docs', 'agent-rules', '15-project-memory.md'), 'utf8'
            );
            assert.ok(content.includes('DO NOT EDIT'));
            assert.ok(content.includes('placeholder templates') || content.includes('no content'),
                'stub must indicate placeholder state');
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });

    it('includes 15-project-memory.md in ruleSourceMap as generated (T-073)', () => {
        const { projectRoot, bundleRoot } = setupTestWorkspace(repoRoot);
        try {
            const result = runInit({
                targetRoot: projectRoot,
                bundleRoot,
                assistantLanguage: 'English',
                assistantBrevity: 'concise',
                sourceOfTruth: 'Claude'
            });

            const pmEntry = result.ruleSourceMap.find(e => e.ruleFile === '15-project-memory.md');
            assert.ok(pmEntry, '15-project-memory.md must be in ruleSourceMap');
            assert.equal(pmEntry.origin, 'generated');
            assert.equal(pmEntry.source, 'docs/project-memory/*');
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });
});

describe('mergeConfig', () => {
    it('preserves existing values over template', () => {
        const result = mergeConfig(
            { a: 1, b: 2, c: 3 },
            { a: 10, b: 20 }
        );
        assert.equal(result.a, 10);
        assert.equal(result.b, 20);
        assert.equal(result.c, 3);
    });

    it('fills missing keys from template', () => {
        const result = mergeConfig(
            { a: 1, b: 2 },
            { a: 10 }
        );
        assert.equal(result.b, 2);
    });

    it('preserves unknown keys from existing', () => {
        const result = mergeConfig(
            { a: 1 },
            { a: 10, custom: 'value' }
        );
        assert.equal(result.custom, 'value');
    });

    it('returns template copy when no existing', () => {
        const result = mergeConfig({ a: 1 }, null);
        assert.equal(result.a, 1);
    });

    it('deep merges nested objects', () => {
        const result = mergeConfig(
            { nested: { a: 1, b: 2 } },
            { nested: { a: 10 } }
        );
        assert.equal((result.nested as Record<string, unknown>).a, 10);
        assert.equal((result.nested as Record<string, unknown>).b, 2);
    });
});

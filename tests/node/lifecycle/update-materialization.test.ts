import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawnSync } from 'node:child_process';

import { runCheckUpdate } from '../../../src/lifecycle/check-update';
import { runUpdate, getUpdateRollbackItems } from '../../../src/lifecycle/update';
import { runUpdateFromGit } from '../../../src/lifecycle/update-git';
import { runContractMigrations } from '../../../src/lifecycle/contract-migrations';
import { getLifecycleOperationLockPath, removePathRecursive, writeUpdateSentinel } from '../../../src/lifecycle/common';
import { formatManifestResult, formatVerifyResult, runVerify, validateManifest } from '../../../src/validators';

type CapturedMaterializationOptions = {
    claudeOrchestratorFullAccess?: boolean;
    providerMinimalism?: boolean;
    activeAgentFilesSeed?: string | null;
};

const TEST_COMPILE_GATE_COMMAND = 'node -e "console.log(\'build ok\')"';

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

function extractMarkdownSection(content: string, heading: string): string {
    const headingMatch = heading.match(/^(#+)\s+/);
    assert.ok(headingMatch, `Heading must be markdown-formatted: ${heading}`);
    const headingLevel = headingMatch[1].length;
    const startPattern = new RegExp(`^${heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'm');
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
    return content.slice(sectionStart, sectionEnd).trim();
}

function seedExecutableBundleSurface(repoRoot: string, bundleRoot: string) {
    fs.copyFileSync(path.join(repoRoot, 'package.json'), path.join(bundleRoot, 'package.json'));
    copyDirRecursive(path.join(repoRoot, 'bin'), path.join(bundleRoot, 'bin'));
    fs.mkdirSync(path.join(bundleRoot, 'dist', 'src'), { recursive: true });
    fs.writeFileSync(path.join(bundleRoot, 'dist', 'src', 'index.js'), 'module.exports = {};', 'utf8');
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

function seedActiveTaskEventLock(bundleRoot: string, lockName: string) {
    const lockPath = path.join(bundleRoot, 'runtime', 'task-events', lockName);
    const now = new Date().toISOString();
    fs.mkdirSync(lockPath, { recursive: true });
    fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
        pid: process.pid,
        hostname: os.hostname(),
        created_at_utc: now,
        heartbeat_at_utc: now
    }), 'utf8');
}

function seedLifecycleOperationLock(projectRoot: string, pid: number, hostname: string = os.hostname()) {
    const lockPath = getLifecycleOperationLockPath(projectRoot);
    fs.mkdirSync(lockPath, { recursive: true });
    fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
        pid,
        hostname,
        operation: 'update',
        acquired_at_utc: '2026-04-05T00:00:00.000Z',
        target_root: path.resolve(projectRoot)
    }, null, 2), 'utf8');
    return lockPath;
}

function seedWorkflowConfigCompileGateCommand(bundleRoot: string, command: string = TEST_COMPILE_GATE_COMMAND) {
    const configPath = path.join(bundleRoot, 'live', 'config', 'workflow-config.json');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({
        compile_gate: {
            command
        }
    }, null, 2), 'utf8');
}

function seedOffModeState(bundleRoot: string) {
    const switchRoot = path.join(bundleRoot, 'runtime', 'switch');
    fs.mkdirSync(switchRoot, { recursive: true });
    fs.writeFileSync(path.join(switchRoot, 'state.json'), JSON.stringify({
        schema_version: 1,
        mode: 'off',
        updated_at_utc: '2026-05-24T00:00:00.000Z',
        candidates: [],
        root_files: [],
        off_storage_files: [],
        on_storage_files: []
    }, null, 2), 'utf8');
}

function seedGitRepository(repoPath: string) {
    const commands = [
        ['init'],
        ['config', 'user.email', 'test@example.com'],
        ['config', 'user.name', 'Garda Test'],
        ['add', '.'],
        ['commit', '-m', 'seed update source']
    ];
    for (const args of commands) {
        const result = spawnSync('git', args, { cwd: repoPath, encoding: 'utf8' });
        assert.equal(
            result.status,
            0,
            `git ${args.join(' ')} failed: ${result.stderr || result.stdout}`
        );
    }
}

function setupUpdateWorkspace(repoRoot: string) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-update-'));
    const bundle = path.join(tmpDir, 'garda-agent-orchestrator');
    fs.mkdirSync(bundle, { recursive: true });

    // Copy VERSION
    fs.copyFileSync(path.join(repoRoot, 'VERSION'), path.join(bundle, 'VERSION'));
    seedExecutableBundleSurface(repoRoot, bundle);

    // Copy template
    copyDirRecursive(path.join(repoRoot, 'template'), path.join(bundle, 'template'));

    // Create live dir
    fs.mkdirSync(path.join(bundle, 'live', 'config'), { recursive: true });
    fs.mkdirSync(path.join(bundle, 'live', 'docs', 'agent-rules'), { recursive: true });
    seedWorkflowConfigCompileGateCommand(bundle);

    // Create runtime dir
    fs.mkdirSync(path.join(bundle, 'runtime'), { recursive: true });

    // Write init-answers.json
    const answers = {
        AssistantLanguage: 'English',
        AssistantBrevity: 'concise',
        SourceOfTruth: 'Claude',
        EnforceNoAutoCommit: 'false',
        ClaudeOrchestratorFullAccess: 'false',
        TokenEconomyEnabled: 'true',
        CollectedVia: 'CLI_NONINTERACTIVE'
    };
    const answersPath = path.join(bundle, 'runtime', 'init-answers.json');
    fs.writeFileSync(answersPath, JSON.stringify(answers, null, 2));

    // Create .git dir for install
    fs.mkdirSync(path.join(tmpDir, '.git', 'hooks'), { recursive: true });

    return {
        projectRoot: tmpDir,
        bundleRoot: bundle,
        answersPath: path.relative(tmpDir, answersPath).replace(/\\/g, '/')
    };
}

function setupSyncedUpdateWorkspace(repoRoot: string) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-update-synced-'));
    const bundle = path.join(tmpDir, 'garda-agent-orchestrator');
    fs.mkdirSync(bundle, { recursive: true });

    const exactFiles = [
        '.gitattributes',
        'AGENT_INIT_PROMPT.md',
        'CHANGELOG.md',
        'HOW_TO.md',
        'LICENSE',
        'MANIFEST.md',
        'README.md',
        'VERSION',
        'package.json'
    ];
    for (const relativePath of exactFiles) {
        fs.copyFileSync(path.join(repoRoot, relativePath), path.join(bundle, relativePath));
    }

    copyDirRecursive(path.join(repoRoot, 'bin'), path.join(bundle, 'bin'));
    fs.mkdirSync(path.join(bundle, 'dist', 'src'), { recursive: true });
    fs.writeFileSync(path.join(bundle, 'dist', 'src', 'index.js'), 'module.exports = {};', 'utf8');
    copyDirRecursive(path.join(repoRoot, 'src'), path.join(bundle, 'src'));
    copyDirRecursive(path.join(repoRoot, 'template'), path.join(bundle, 'template'));

    fs.mkdirSync(path.join(bundle, 'live', 'config'), { recursive: true });
    fs.mkdirSync(path.join(bundle, 'live', 'docs', 'agent-rules'), { recursive: true });
    seedWorkflowConfigCompileGateCommand(bundle);
    fs.mkdirSync(path.join(bundle, 'runtime'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, '.git', 'hooks'), { recursive: true });

    const answers = {
        AssistantLanguage: 'English',
        AssistantBrevity: 'concise',
        SourceOfTruth: 'Claude',
        EnforceNoAutoCommit: 'false',
        ClaudeOrchestratorFullAccess: 'false',
        TokenEconomyEnabled: 'true',
        CollectedVia: 'CLI_NONINTERACTIVE'
    };
    const answersPath = path.join(bundle, 'runtime', 'init-answers.json');
    fs.writeFileSync(answersPath, JSON.stringify(answers, null, 2));

    return {
        projectRoot: tmpDir,
        bundleRoot: bundle,
        answersPath: path.relative(tmpDir, answersPath).replace(/\\/g, '/')
    };
}

describe('runUpdate', () => {
    const repoRoot = findRepoRoot();
    it('rematerializes live/ content during update', () => {
        const { projectRoot, bundleRoot, answersPath } = setupUpdateWorkspace(repoRoot);
        try {
            // Seed stale live/ content to simulate a previous version
            const liveRuleDir = path.join(bundleRoot, 'live', 'docs', 'agent-rules');
            fs.mkdirSync(liveRuleDir, { recursive: true });
            fs.writeFileSync(path.join(liveRuleDir, '00-core.md'), 'STALE_CORE_RULE');

            const liveConfigDir = path.join(bundleRoot, 'live', 'config');
            fs.mkdirSync(liveConfigDir, { recursive: true });
            fs.writeFileSync(path.join(liveConfigDir, 'skills-index.json'), '{"stale":true}');
            fs.writeFileSync(path.join(liveConfigDir, 'skills-headlines.json'), '{"stale":true}');

            const liveSkillsDir = path.join(bundleRoot, 'live', 'skills');
            fs.mkdirSync(liveSkillsDir, { recursive: true });
            fs.writeFileSync(path.join(liveSkillsDir, 'stale-marker.txt'), 'STALE');

            const result = runUpdate({
                targetRoot: projectRoot,
                bundleRoot,
                initAnswersPath: answersPath,
                skipVerify: true,
                skipManifestValidation: true
            });

            assert.equal(result.installStatus, 'PASS');
            assert.equal(result.materializationStatus, 'PASS');

            // 00-core.md should be refreshed from template, not stale
            const coreRuleContent = fs.readFileSync(path.join(liveRuleDir, '00-core.md'), 'utf8');
            assert.ok(coreRuleContent !== 'STALE_CORE_RULE', 'Core rule should be refreshed from template');
            assert.ok(coreRuleContent.length > 10, 'Core rule should have real content');

            // skills-index.json should be regenerated, not stale
            const skillsIndex = JSON.parse(fs.readFileSync(path.join(liveConfigDir, 'skills-index.json'), 'utf8'));
            assert.ok(!skillsIndex.stale, 'Skills index should be regenerated');
            assert.ok(Array.isArray(skillsIndex.packs) || Array.isArray(skillsIndex.skills),
                'Skills index should have valid structure');

            const skillsHeadlines = JSON.parse(fs.readFileSync(path.join(liveConfigDir, 'skills-headlines.json'), 'utf8'));
            assert.ok(!skillsHeadlines.stale, 'Skills headlines should be regenerated');
            assert.ok(Array.isArray(skillsHeadlines.skills), 'Skills headlines should expose compact skill entries');

            // live/version.json should have been written
            const liveVersion = JSON.parse(
                fs.readFileSync(path.join(bundleRoot, 'live', 'version.json'), 'utf8')
            );
            assert.ok(liveVersion.Version, 'live/version.json should have Version');
        } finally {
            removePathRecursive(projectRoot);
        }
    });

    it('rematerializes config files from template during update', () => {
        const { projectRoot, bundleRoot, answersPath } = setupUpdateWorkspace(repoRoot);
        try {
            // Ensure live/config has stale content
            const liveConfigDir = path.join(bundleRoot, 'live', 'config');
            fs.mkdirSync(liveConfigDir, { recursive: true });

            // Write a minimal stale token-economy config
            fs.writeFileSync(
                path.join(liveConfigDir, 'token-economy.json'),
                JSON.stringify({ enabled: false, staleFlag: true }, null, 2)
            );

            const result = runUpdate({
                targetRoot: projectRoot,
                bundleRoot,
                initAnswersPath: answersPath,
                skipVerify: true,
                skipManifestValidation: true
            });

            assert.equal(result.materializationStatus, 'PASS');

            // token-economy.json should be merged: existing values preserved, template keys filled
            const tokenEconomy = JSON.parse(
                fs.readFileSync(path.join(liveConfigDir, 'token-economy.json'), 'utf8')
            );
            // TokenEconomyEnabled is 'true' in init answers, so enabled should be true
            assert.equal(tokenEconomy.enabled, true, 'Token economy enabled flag should match init answers');
        } finally {
            removePathRecursive(projectRoot);
        }
    });

    it('preserves explicit workflow-config values during update', () => {
        const { projectRoot, bundleRoot, answersPath } = setupUpdateWorkspace(repoRoot);
        try {
            const workflowConfigPath = path.join(bundleRoot, 'live', 'config', 'workflow-config.json');
            fs.writeFileSync(
                workflowConfigPath,
                JSON.stringify({
                    full_suite_validation: {
                        enabled: true,
                        command: 'npm run test:full',
                        timeout_ms: 123456,
                        green_summary_max_lines: 7,
                        red_failure_chunk_lines: 42,
                        out_of_scope_failure_policy: 'AUDIT_AND_WARN',
                        auto_open_report: true
                    },
                    review_execution_policy: {
                        mode: 'strict_sequential'
                    }
                }, null, 2),
                'utf8'
            );

            const result = runUpdate({
                targetRoot: projectRoot,
                bundleRoot,
                initAnswersPath: answersPath,
                skipVerify: true,
                skipManifestValidation: true
            });

            assert.equal(result.materializationStatus, 'PASS');
            assert.equal(
                result.workflowConfigMergeStatus,
                'existing_values_preserved_and_missing_keys_filled path=garda-agent-orchestrator/live/config/workflow-config.json full_suite_validation.enabled=true project_memory_maintenance.enabled=true project_memory_maintenance.mode=update review_cycle_guard.max_failed_non_test_reviews=15 review_cycle_guard.max_total_non_test_reviews=30 review_cycle_guard.limit_status=missing_keys_filled_from_template'
            );

            const workflowConfig = JSON.parse(fs.readFileSync(workflowConfigPath, 'utf8'));
            assert.deepEqual(workflowConfig.full_suite_validation, {
                enabled: true,
                command: 'npm run test:full',
                timeout_ms: 123456,
                green_summary_max_lines: 7,
                red_failure_chunk_lines: 42,
                out_of_scope_failure_policy: 'AUDIT_AND_WARN',
                auto_open_report: true,
                placement: 'after_compile_before_reviews'
            });
            assert.deepEqual(workflowConfig.review_execution_policy, {
                mode: 'strict_sequential'
            });
            assert.deepEqual(workflowConfig.project_memory_maintenance, {
                enabled: true,
                mode: 'update',
                run_before_final_closeout: true,
                require_user_approval_for_writes: true,
                max_compact_summary_chars: 12000,
                read_strategy: 'index_first',
                impact_artifact_retention_days: 30
            });
        } finally {
            removePathRecursive(projectRoot);
        }
    });

    it('preserves explicit project-memory maintenance mode during update', () => {
        const { projectRoot, bundleRoot, answersPath } = setupUpdateWorkspace(repoRoot);
        try {
            const workflowConfigPath = path.join(bundleRoot, 'live', 'config', 'workflow-config.json');
            fs.writeFileSync(
                workflowConfigPath,
                JSON.stringify({
                    full_suite_validation: {
                        enabled: true,
                        command: 'npm run test:full',
                        timeout_ms: 123456,
                        green_summary_max_lines: 7,
                        red_failure_chunk_lines: 42,
                        out_of_scope_failure_policy: 'AUDIT_AND_WARN'
                    },
                    project_memory_maintenance: {
                        enabled: true,
                        mode: 'check',
                        run_before_final_closeout: true,
                        require_user_approval_for_writes: true,
                        max_compact_summary_chars: 9000,
                        read_strategy: 'index_first',
                        impact_artifact_retention_days: 10
                    }
                }, null, 2),
                'utf8'
            );

            const result = runUpdate({
                targetRoot: projectRoot,
                bundleRoot,
                initAnswersPath: answersPath,
                skipVerify: true,
                skipManifestValidation: true
            });

            assert.equal(result.materializationStatus, 'PASS');
            assert.equal(
                result.workflowConfigMergeStatus,
                'existing_values_preserved_and_missing_keys_filled path=garda-agent-orchestrator/live/config/workflow-config.json full_suite_validation.enabled=true project_memory_maintenance.enabled=true project_memory_maintenance.mode=check review_cycle_guard.max_failed_non_test_reviews=15 review_cycle_guard.max_total_non_test_reviews=30 review_cycle_guard.limit_status=missing_keys_filled_from_template'
            );
            assert.equal(result.projectMemoryMaintenanceSummaryLine, 'Project memory maintenance: check read_strategy=index_first max_compact_summary_chars=9000 require_user_approval_for_writes=true');

            const workflowConfig = JSON.parse(fs.readFileSync(workflowConfigPath, 'utf8'));
            assert.equal(workflowConfig.project_memory_maintenance.mode, 'check');
            assert.equal(workflowConfig.project_memory_maintenance.max_compact_summary_chars, 9000);
        } finally {
            removePathRecursive(projectRoot);
        }
    });

    it('migrates exact legacy generated project-memory maintenance default during update', () => {
        const { projectRoot, bundleRoot, answersPath } = setupUpdateWorkspace(repoRoot);
        try {
            const workflowConfigPath = path.join(bundleRoot, 'live', 'config', 'workflow-config.json');
            fs.writeFileSync(
                workflowConfigPath,
                JSON.stringify({
                    full_suite_validation: {
                        enabled: true,
                        command: 'npm run test:full',
                        timeout_ms: 123456,
                        green_summary_max_lines: 7,
                        red_failure_chunk_lines: 42,
                        out_of_scope_failure_policy: 'AUDIT_AND_WARN'
                    },
                    project_memory_maintenance: {
                        enabled: false,
                        mode: 'check',
                        run_before_final_closeout: true,
                        require_user_approval_for_writes: true,
                        max_compact_summary_chars: 12000,
                        read_strategy: 'index_first',
                        impact_artifact_retention_days: 30
                    }
                }, null, 2),
                'utf8'
            );

            const result = runUpdate({
                targetRoot: projectRoot,
                bundleRoot,
                initAnswersPath: answersPath,
                skipVerify: true,
                skipManifestValidation: true
            });

            assert.equal(result.materializationStatus, 'PASS');
            assert.equal(
                result.workflowConfigMergeStatus,
                'existing_values_preserved_and_missing_keys_filled path=garda-agent-orchestrator/live/config/workflow-config.json full_suite_validation.enabled=true project_memory_maintenance.enabled=true project_memory_maintenance.mode=update review_cycle_guard.max_failed_non_test_reviews=15 review_cycle_guard.max_total_non_test_reviews=30 review_cycle_guard.limit_status=missing_keys_filled_from_template'
            );
            assert.equal(result.projectMemoryMaintenanceSummaryLine, 'Project memory maintenance: update read_strategy=index_first max_compact_summary_chars=12000 require_user_approval_for_writes=true');

            const workflowConfig = JSON.parse(fs.readFileSync(workflowConfigPath, 'utf8'));
            assert.equal(workflowConfig.project_memory_maintenance.enabled, true);
            assert.equal(workflowConfig.project_memory_maintenance.mode, 'update');
        } finally {
            removePathRecursive(projectRoot);
        }
    });

    it('preserves legacy-looking custom project-memory maintenance opt-out during update', () => {
        const { projectRoot, bundleRoot, answersPath } = setupUpdateWorkspace(repoRoot);
        try {
            const workflowConfigPath = path.join(bundleRoot, 'live', 'config', 'workflow-config.json');
            fs.writeFileSync(
                workflowConfigPath,
                JSON.stringify({
                    full_suite_validation: {
                        enabled: true,
                        command: 'npm run test:full',
                        timeout_ms: 123456,
                        green_summary_max_lines: 7,
                        red_failure_chunk_lines: 42,
                        out_of_scope_failure_policy: 'AUDIT_AND_WARN'
                    },
                    project_memory_maintenance: {
                        enabled: false,
                        mode: 'check',
                        run_before_final_closeout: true,
                        require_user_approval_for_writes: true,
                        max_compact_summary_chars: 9000,
                        read_strategy: 'index_first',
                        impact_artifact_retention_days: 30
                    }
                }, null, 2),
                'utf8'
            );

            const result = runUpdate({
                targetRoot: projectRoot,
                bundleRoot,
                initAnswersPath: answersPath,
                skipVerify: true,
                skipManifestValidation: true
            });

            assert.equal(result.materializationStatus, 'PASS');
            assert.equal(
                result.workflowConfigMergeStatus,
                'existing_values_preserved_and_missing_keys_filled path=garda-agent-orchestrator/live/config/workflow-config.json full_suite_validation.enabled=true project_memory_maintenance.enabled=false project_memory_maintenance.mode=off review_cycle_guard.max_failed_non_test_reviews=15 review_cycle_guard.max_total_non_test_reviews=30 review_cycle_guard.limit_status=missing_keys_filled_from_template'
            );
            assert.equal(result.projectMemoryMaintenanceSummaryLine, 'Project memory maintenance: disabled read_strategy=index_first max_compact_summary_chars=9000 require_user_approval_for_writes=true');

            const workflowConfig = JSON.parse(fs.readFileSync(workflowConfigPath, 'utf8'));
            assert.equal(workflowConfig.project_memory_maintenance.enabled, false);
            assert.equal(workflowConfig.project_memory_maintenance.mode, 'check');
            assert.equal(workflowConfig.project_memory_maintenance.max_compact_summary_chars, 9000);
        } finally {
            removePathRecursive(projectRoot);
        }
    });

    it('fills missing project-memory maintenance mode from update default', () => {
        const { projectRoot, bundleRoot, answersPath } = setupUpdateWorkspace(repoRoot);
        try {
            const workflowConfigPath = path.join(bundleRoot, 'live', 'config', 'workflow-config.json');
            fs.writeFileSync(
                workflowConfigPath,
                JSON.stringify({
                    full_suite_validation: {
                        enabled: false,
                        command: 'npm test',
                        timeout_ms: 600000,
                        green_summary_max_lines: 5,
                        red_failure_chunk_lines: 50,
                        out_of_scope_failure_policy: 'AUDIT_AND_BLOCK'
                    },
                    project_memory_maintenance: {
                        enabled: true,
                        run_before_final_closeout: true,
                        require_user_approval_for_writes: true,
                        max_compact_summary_chars: 12000,
                        read_strategy: 'index_first',
                        impact_artifact_retention_days: 30
                    }
                }, null, 2),
                'utf8'
            );

            const result = runUpdate({
                targetRoot: projectRoot,
                bundleRoot,
                initAnswersPath: answersPath,
                skipVerify: true,
                skipManifestValidation: true
            });

            assert.equal(result.materializationStatus, 'PASS');
            assert.equal(result.projectMemoryMaintenanceSummaryLine, 'Project memory maintenance: update read_strategy=index_first max_compact_summary_chars=12000 require_user_approval_for_writes=true');

            const workflowConfig = JSON.parse(fs.readFileSync(workflowConfigPath, 'utf8'));
            assert.equal(workflowConfig.project_memory_maintenance.mode, 'update');
        } finally {
            removePathRecursive(projectRoot);
        }
    });

    it('preserves legacy workflow-config omission for review_execution_policy during update', () => {
        const { projectRoot, bundleRoot, answersPath } = setupUpdateWorkspace(repoRoot);
        try {
            const workflowConfigPath = path.join(bundleRoot, 'live', 'config', 'workflow-config.json');
            fs.writeFileSync(
                workflowConfigPath,
                JSON.stringify({
                    full_suite_validation: {
                        enabled: true,
                        command: 'npm run test:full',
                        timeout_ms: 123456,
                        green_summary_max_lines: 7,
                        red_failure_chunk_lines: 42,
                        out_of_scope_failure_policy: 'AUDIT_AND_WARN'
                    }
                }, null, 2),
                'utf8'
            );

            const result = runUpdate({
                targetRoot: projectRoot,
                bundleRoot,
                initAnswersPath: answersPath,
                skipVerify: true,
                skipManifestValidation: true
            });

            assert.equal(result.materializationStatus, 'PASS');
            assert.equal(
                result.workflowConfigMergeStatus,
                'existing_values_preserved_and_missing_keys_filled path=garda-agent-orchestrator/live/config/workflow-config.json full_suite_validation.enabled=true project_memory_maintenance.enabled=true project_memory_maintenance.mode=update review_cycle_guard.max_failed_non_test_reviews=15 review_cycle_guard.max_total_non_test_reviews=30 review_cycle_guard.limit_status=missing_keys_filled_from_template'
            );

            const workflowConfig = JSON.parse(fs.readFileSync(workflowConfigPath, 'utf8'));
            assert.deepEqual(workflowConfig.full_suite_validation, {
                enabled: true,
                command: 'npm run test:full',
                timeout_ms: 123456,
                green_summary_max_lines: 7,
                red_failure_chunk_lines: 42,
                out_of_scope_failure_policy: 'AUDIT_AND_WARN',
                placement: 'after_compile_before_reviews'
            });
            assert.equal(Object.prototype.hasOwnProperty.call(workflowConfig, 'review_execution_policy'), false);
        } finally {
            removePathRecursive(projectRoot);
        }
    });

    it('materializes legacy-compatible workflow-config when update refreshes a missing config', () => {
        const { projectRoot, bundleRoot, answersPath } = setupUpdateWorkspace(repoRoot);
        try {
            const workflowConfigPath = path.join(bundleRoot, 'live', 'config', 'workflow-config.json');
            fs.rmSync(workflowConfigPath, { force: true });

            const result = runUpdate({
                targetRoot: projectRoot,
                bundleRoot,
                initAnswersPath: answersPath,
                skipVerify: true,
                skipManifestValidation: true
            });

            assert.equal(result.materializationStatus, 'PASS');
            assert.equal(
                result.workflowConfigMergeStatus,
                'live_config_missing_template_applied path=garda-agent-orchestrator/live/config/workflow-config.json full_suite_validation.enabled=false project_memory_maintenance.enabled=true project_memory_maintenance.mode=update review_cycle_guard.max_failed_non_test_reviews=15 review_cycle_guard.max_total_non_test_reviews=30 review_cycle_guard.limit_status=template_default_applied'
            );

            const workflowConfig = JSON.parse(fs.readFileSync(workflowConfigPath, 'utf8'));
            assert.deepEqual(workflowConfig.full_suite_validation, {
                enabled: false,
                command: '__FULL_SUITE_COMMAND_UNCONFIGURED__',
                timeout_ms: 600000,
                green_summary_max_lines: 5,
                red_failure_chunk_lines: 50,
                out_of_scope_failure_policy: 'AUDIT_AND_BLOCK',
                placement: 'after_compile_before_reviews'
            });
            assert.equal(Object.prototype.hasOwnProperty.call(workflowConfig, 'review_execution_policy'), false);
            assert.equal(workflowConfig.review_cycle_guard.max_failed_non_test_reviews, 15);
            assert.equal(workflowConfig.review_cycle_guard.max_total_non_test_reviews, 30);
        } finally {
            removePathRecursive(projectRoot);
        }
    });

    it('migrates exact legacy review-cycle guard defaults during update', () => {
        const { projectRoot, bundleRoot, answersPath } = setupUpdateWorkspace(repoRoot);
        try {
            const workflowConfigPath = path.join(bundleRoot, 'live', 'config', 'workflow-config.json');
            fs.writeFileSync(
                workflowConfigPath,
                JSON.stringify({
                    full_suite_validation: {
                        enabled: true,
                        command: 'npm run test:full',
                        timeout_ms: 123456,
                        green_summary_max_lines: 7,
                        red_failure_chunk_lines: 42,
                        out_of_scope_failure_policy: 'AUDIT_AND_WARN'
                    },
                    review_cycle_guard: {
                        enabled: true,
                        action: 'BLOCK_FOR_OPERATOR_DECISION',
                        max_failed_non_test_reviews: 15,
                        max_total_non_test_reviews: 15,
                        excluded_review_types: ['test'],
                        auto_split_enabled: false
                    }
                }, null, 2),
                'utf8'
            );

            const result = runUpdate({
                targetRoot: projectRoot,
                bundleRoot,
                initAnswersPath: answersPath,
                skipVerify: true,
                skipManifestValidation: true
            });

            assert.equal(result.materializationStatus, 'PASS');
            assert.equal(
                result.workflowConfigMergeStatus,
                'existing_values_preserved_and_missing_keys_filled path=garda-agent-orchestrator/live/config/workflow-config.json full_suite_validation.enabled=true project_memory_maintenance.enabled=true project_memory_maintenance.mode=update review_cycle_guard.max_failed_non_test_reviews=15 review_cycle_guard.max_total_non_test_reviews=30 review_cycle_guard.limit_status=migrated_from_old_default'
            );

            const workflowConfig = JSON.parse(fs.readFileSync(workflowConfigPath, 'utf8'));
            assert.equal(workflowConfig.review_cycle_guard.max_failed_non_test_reviews, 15);
            assert.equal(workflowConfig.review_cycle_guard.max_total_non_test_reviews, 30);
            assert.equal(workflowConfig.review_cycle_guard.auto_split_enabled, false);
        } finally {
            removePathRecursive(projectRoot);
        }
    });

    it('preserves custom review-cycle guard limits during update', () => {
        const { projectRoot, bundleRoot, answersPath } = setupUpdateWorkspace(repoRoot);
        try {
            const workflowConfigPath = path.join(bundleRoot, 'live', 'config', 'workflow-config.json');
            fs.writeFileSync(
                workflowConfigPath,
                JSON.stringify({
                    full_suite_validation: {
                        enabled: true,
                        command: 'npm run test:full',
                        timeout_ms: 123456,
                        green_summary_max_lines: 7,
                        red_failure_chunk_lines: 42,
                        out_of_scope_failure_policy: 'AUDIT_AND_WARN'
                    },
                    review_cycle_guard: {
                        enabled: true,
                        action: 'BLOCK_FOR_OPERATOR_DECISION',
                        max_failed_non_test_reviews: 12,
                        max_total_non_test_reviews: 15,
                        excluded_review_types: ['test'],
                        auto_split_enabled: true
                    }
                }, null, 2),
                'utf8'
            );

            const result = runUpdate({
                targetRoot: projectRoot,
                bundleRoot,
                initAnswersPath: answersPath,
                skipVerify: true,
                skipManifestValidation: true
            });

            assert.equal(result.materializationStatus, 'PASS');
            assert.equal(
                result.workflowConfigMergeStatus,
                'existing_values_preserved_and_missing_keys_filled path=garda-agent-orchestrator/live/config/workflow-config.json full_suite_validation.enabled=true project_memory_maintenance.enabled=true project_memory_maintenance.mode=update review_cycle_guard.max_failed_non_test_reviews=12 review_cycle_guard.max_total_non_test_reviews=15 review_cycle_guard.limit_status=custom_preserved'
            );

            const workflowConfig = JSON.parse(fs.readFileSync(workflowConfigPath, 'utf8'));
            assert.equal(workflowConfig.review_cycle_guard.max_failed_non_test_reviews, 12);
            assert.equal(workflowConfig.review_cycle_guard.max_total_non_test_reviews, 15);
            assert.equal(workflowConfig.review_cycle_guard.auto_split_enabled, true);
        } finally {
            removePathRecursive(projectRoot);
        }
    });

    it('rolls back on materialization failure', () => {
        const { projectRoot, bundleRoot, answersPath } = setupUpdateWorkspace(repoRoot);
        try {
            // Create a file that should be in pre-update snapshot
            fs.writeFileSync(path.join(projectRoot, 'CLAUDE.md'), 'pre-update-content');

            assert.throws(
                () => runUpdate({
                    targetRoot: projectRoot,
                    bundleRoot,
                    initAnswersPath: answersPath,
                    skipVerify: true,
                    skipManifestValidation: true,
                    materializationRunner: () => {
                        throw new Error('Simulated materialization failure');
                    }
                }),
                /rollback completed successfully.*Simulated materialization failure/
            );

            // CLAUDE.md should be restored by rollback
            assert.ok(fs.existsSync(path.join(projectRoot, 'CLAUDE.md')));
            assert.equal(
                fs.readFileSync(path.join(projectRoot, 'CLAUDE.md'), 'utf8'),
                'pre-update-content'
            );
        } finally {
            removePathRecursive(projectRoot);
        }
    });

    it('does not rematerialize live/ in dry-run mode', () => {
        const { projectRoot, bundleRoot, answersPath } = setupUpdateWorkspace(repoRoot);
        try {
            // Seed stale live/ content
            const liveRuleDir = path.join(bundleRoot, 'live', 'docs', 'agent-rules');
            fs.mkdirSync(liveRuleDir, { recursive: true });
            fs.writeFileSync(path.join(liveRuleDir, '00-core.md'), 'STALE_DRY_RUN');

            const result = runUpdate({
                targetRoot: projectRoot,
                bundleRoot,
                initAnswersPath: answersPath,
                dryRun: true
            });

            assert.equal(result.materializationStatus, 'SKIPPED_DRY_RUN');

            // Stale content should remain since it's a dry run
            const coreRuleContent = fs.readFileSync(path.join(liveRuleDir, '00-core.md'), 'utf8');
            assert.equal(coreRuleContent, 'STALE_DRY_RUN', 'Dry run should not modify live/ content');
        } finally {
            removePathRecursive(projectRoot);
        }
    });

    it('reports SKIPPED_NO_RUNNER for verify/manifest/contractMigrations when no runners provided', () => {
        const { projectRoot, bundleRoot, answersPath } = setupUpdateWorkspace(repoRoot);
        try {
            const result = runUpdate({
                targetRoot: projectRoot,
                bundleRoot,
                initAnswersPath: answersPath,
                skipVerify: false,
                skipManifestValidation: false
            });

            assert.equal(result.installStatus, 'PASS');
            assert.equal(result.materializationStatus, 'PASS');
            assert.equal(result.verifyStatus, 'SKIPPED_NO_RUNNER',
                'Verify must not report PASS when no verifyRunner was provided');
            assert.equal(result.manifestValidationStatus, 'SKIPPED_NO_RUNNER',
                'ManifestValidation must not report PASS when no manifestRunner was provided');
            assert.equal(result.contractMigrationStatus, 'SKIPPED_NO_RUNNER',
                'ContractMigrations must not report PASS when no contractMigrationRunner was provided');

            // Report should reflect truthful statuses
            const reportPath = path.join(projectRoot, result.updateReportPath);
            const reportContent = fs.readFileSync(reportPath, 'utf8');
            assert.ok(reportContent.includes('Verify: SKIPPED_NO_RUNNER'));
            assert.ok(reportContent.includes('ManifestValidation: SKIPPED_NO_RUNNER'));
            assert.ok(reportContent.includes('ContractMigrations: SKIPPED_NO_RUNNER'));
        } finally {
            removePathRecursive(projectRoot);
        }
    });

    it('reports PASS for verify/manifest/contractMigrations when runners succeed', () => {
        const { projectRoot, bundleRoot, answersPath } = setupUpdateWorkspace(repoRoot);
        try {
            let verifyCalled = false;
            let manifestCalled = false;
            let migrationCalled = false;

            const result = runUpdate({
                targetRoot: projectRoot,
                bundleRoot,
                initAnswersPath: answersPath,
                skipVerify: false,
                skipManifestValidation: false,
                verifyRunner: () => { verifyCalled = true; },
                manifestRunner: () => { manifestCalled = true; },
                contractMigrationRunner: () => {
                    migrationCalled = true;
                    return { appliedCount: 1, appliedFiles: ['test-migration.js'] };
                }
            });

            assert.ok(verifyCalled, 'verifyRunner should have been called');
            assert.ok(manifestCalled, 'manifestRunner should have been called');
            assert.ok(migrationCalled, 'contractMigrationRunner should have been called');
            assert.equal(result.verifyStatus, 'PASS');
            assert.equal(result.manifestValidationStatus, 'PASS');
            assert.equal(result.contractMigrationStatus, 'PASS');
            assert.equal(result.contractMigrationCount, 1);
            assert.deepEqual(result.contractMigrationFiles, ['test-migration.js']);
        } finally {
            removePathRecursive(projectRoot);
        }
    });

    it('migrates stale live task-mode rule contracts before verify and manifest validation', () => {
        const { projectRoot, bundleRoot, answersPath } = setupSyncedUpdateWorkspace(repoRoot);
        try {
            const liveRuleDir = path.join(bundleRoot, 'live', 'docs', 'agent-rules');
            fs.mkdirSync(liveRuleDir, { recursive: true });
            fs.writeFileSync(path.join(liveRuleDir, '40-commands.md'), [
                '# Commands',
                '',
                '## Agent Gates',
                '```bash',
                'node garda-agent-orchestrator/bin/garda.js gate classify-change --changed-file "src/example.ts"',
                '```'
            ].join('\n'), 'utf8');
            fs.writeFileSync(path.join(liveRuleDir, '80-task-workflow.md'), [
                '# Task Workflow',
                '',
                '## Integrity Priority Rules',
                'Honest execution and strict workflow compliance outrank speed, autonomy, context preservation, and token economy.',
                '',
                '## Notes',
                'Mandatory gate failure means stop or `BLOCKED`; never workaround the gate, script around it, or claim progress that depends on missing evidence.',
                'Agent-authored scripts may automate ordinary repository work, but they must not batch, loop over, or green-light orchestrator gates or write review, receipt, routing, telemetry, status, or commit-readiness evidence unless the task itself is to change orchestrator code.',
                'Fabricated review artifacts, receipts, routing metadata, telemetry, task statuses, or commit-readiness claims are critical workflow violations.',
                'If asked about workflow misconduct or integrity defects, disclose the full known set from the current run, not only the latest discovered issue.',
                '',
                '## Mandatory Gate Contract',
                '- Preflight artifact must exist before review stage.',
                '- Compile gate command must pass before `IN_REVIEW`.'
            ].join('\n'), 'utf8');
            fs.writeFileSync(path.join(liveRuleDir, '90-skill-catalog.md'), [
                '# Skill Catalog',
                '',
                '## Integrity Priority Rules',
                'Honest execution and strict workflow compliance outrank speed, autonomy, context preservation, and token economy.',
                '',
                '## Notes',
                'Skill routing, optional skills, and token-economy settings never authorize skipping mandatory gates or synthesizing workflow evidence.',
                'Agent-authored scripts may automate ordinary repository work, but they must not batch, loop over, or green-light orchestrator gates or write review, receipt, routing, telemetry, status, or commit-readiness evidence unless the task itself is to change orchestrator code.',
                'If asked about workflow misconduct or integrity defects, disclose the full known set from the current run, not only the latest discovered issue.',
                '',
                '## Preflight Gate (Mandatory)',
                '- Run before review stage:',
                '  `node garda-agent-orchestrator/bin/garda.js gate classify-change --task-intent "<task summary>"`',
                '',
                '## Enforcement',
                '- Missing preflight artifact blocks progression.'
            ].join('\n'), 'utf8');

            const result = runUpdate({
                targetRoot: projectRoot,
                bundleRoot,
                initAnswersPath: answersPath,
                skipVerify: false,
                skipManifestValidation: false,
                contractMigrationRunner: (options) => runContractMigrations(options),
                verifyRunner: (options) => {
                    const verifyResult = runVerify({
                        targetRoot: options.targetRoot,
                        sourceOfTruth: options.sourceOfTruth,
                        initAnswersPath: options.initAnswersPath
                    });
                    if (!verifyResult.passed) {
                        throw new Error(formatVerifyResult(verifyResult));
                    }
                    return verifyResult;
                },
                manifestRunner: (options) => {
                    const manifestPath = path.join(options.targetRoot, 'garda-agent-orchestrator', 'MANIFEST.md');
                    const manifestResult = validateManifest(manifestPath, options.targetRoot);
                    if (!manifestResult.passed) {
                        throw new Error(formatManifestResult(manifestResult));
                    }
                    return manifestResult;
                }
            });

            assert.equal(result.installStatus, 'PASS');
            assert.equal(result.materializationStatus, 'PASS');
            assert.equal(result.contractMigrationStatus, 'PASS');
            assert.equal(result.verifyStatus, 'PASS');
            assert.equal(result.manifestValidationStatus, 'PASS');
            assert.equal(result.contractMigrationCount, 3);
            assert.deepEqual(result.contractMigrationFiles, [
                'garda-agent-orchestrator/live/docs/agent-rules/40-commands.md',
                'garda-agent-orchestrator/live/docs/agent-rules/80-task-workflow.md',
                'garda-agent-orchestrator/live/docs/agent-rules/90-skill-catalog.md'
            ]);

            const commandsContent = fs.readFileSync(path.join(liveRuleDir, '40-commands.md'), 'utf8');
            const taskWorkflowContent = fs.readFileSync(path.join(liveRuleDir, '80-task-workflow.md'), 'utf8');
            const skillCatalogContent = fs.readFileSync(path.join(liveRuleDir, '90-skill-catalog.md'), 'utf8');
            const templateRuleDir = path.join(bundleRoot, 'template', 'docs', 'agent-rules');
            const taskWorkflowTemplateContent = fs.readFileSync(path.join(templateRuleDir, '80-task-workflow.md'), 'utf8');
            const skillCatalogTemplateContent = fs.readFileSync(path.join(templateRuleDir, '90-skill-catalog.md'), 'utf8');
            const taskWorkflowIntegritySection = extractMarkdownSection(taskWorkflowContent, '## Integrity Priority Rules');
            const skillCatalogIntegritySection = extractMarkdownSection(skillCatalogContent, '## Integrity Priority Rules');

            assert.ok(commandsContent.includes('node garda-agent-orchestrator/bin/garda.js gate enter-task-mode'));
            assert.ok(commandsContent.includes('node garda-agent-orchestrator/bin/garda.js gate load-rule-pack'));
            assert.ok(taskWorkflowContent.includes('TASK_MODE_ENTERED'));
            assert.ok(taskWorkflowContent.includes('RULE_PACK_LOADED'));
            assert.equal(
                taskWorkflowIntegritySection,
                extractMarkdownSection(taskWorkflowTemplateContent, '## Integrity Priority Rules')
            );
            assert.equal(
                skillCatalogIntegritySection,
                extractMarkdownSection(skillCatalogTemplateContent, '## Integrity Priority Rules')
            );
            assert.ok(skillCatalogContent.includes('Missing rule-pack artifact (`runtime/reviews/<task-id>-rule-pack.json`) blocks progression.'));
            assert.ok(skillCatalogContent.includes('Missing task-mode entry artifact (`runtime/reviews/<task-id>-task-mode.json`) blocks progression.'));
        } finally {
            removePathRecursive(projectRoot);
        }
    });

    it('preserves existing project-specific compile gate command during contract migration', () => {
        const { projectRoot, bundleRoot, answersPath } = setupSyncedUpdateWorkspace(repoRoot);
        try {
            fs.writeFileSync(path.join(projectRoot, 'settings.gradle'), 'pluginManagement { repositories { gradlePluginPortal() } }\n', 'utf8');
            fs.writeFileSync(path.join(projectRoot, 'build.gradle'), 'plugins { id "java" }\n', 'utf8');
            fs.writeFileSync(path.join(projectRoot, 'gradlew.bat'), '@echo off\r\n', 'utf8');

            const liveRuleDir = path.join(bundleRoot, 'live', 'docs', 'agent-rules');
            fs.mkdirSync(liveRuleDir, { recursive: true });
            fs.writeFileSync(path.join(liveRuleDir, '40-commands.md'), [
                '# Commands',
                '',
                '## Agent Gates',
                '```bash',
                'node garda-agent-orchestrator/bin/garda.js gate classify-change --changed-file "src/example.ts"',
                '```',
                '',
                '### Compile Gate (Mandatory)',
                '```bash',
                '.\\gradlew.bat clean testClasses --console=plain',
                '```',
                '',
                'Rules:',
                '- First non-empty non-comment line from this block is the compile gate command.'
            ].join('\n'), 'utf8');
            seedWorkflowConfigCompileGateCommand(bundleRoot, '__COMPILE_GATE_COMMAND_UNCONFIGURED__');

            const result = runUpdate({
                targetRoot: projectRoot,
                bundleRoot,
                initAnswersPath: answersPath,
                skipVerify: true,
                skipManifestValidation: true,
                contractMigrationRunner: (options) => runContractMigrations(options)
            });

            assert.equal(result.installStatus, 'PASS');
            assert.equal(result.materializationStatus, 'PASS');
            assert.equal(result.contractMigrationStatus, 'PASS');
            assert.deepEqual(result.contractMigrationFiles, [
                'garda-agent-orchestrator/live/docs/agent-rules/40-commands.md'
            ]);

            const commandsContent = fs.readFileSync(path.join(liveRuleDir, '40-commands.md'), 'utf8');
            const compileSection = extractMarkdownSection(commandsContent, '### Compile Gate (Mandatory)');
            assert.ok(compileSection.includes('.\\gradlew.bat clean testClasses --console=plain'));
            assert.ok(!/```bash\r?\nnpm run build\r?\n```/.test(compileSection));
            assert.ok(compileSection.includes('must be a compile/build/type-check command'));
            assert.ok(compileSection.includes('Do not use full-suite test commands here'));

            const workflowConfigPath = path.join(bundleRoot, 'live', 'config', 'workflow-config.json');
            const workflowConfig = JSON.parse(fs.readFileSync(workflowConfigPath, 'utf8')) as Record<string, unknown>;
            const compileGate = workflowConfig.compile_gate as Record<string, unknown>;
            assert.equal(compileGate.command, '.\\gradlew.bat clean testClasses --console=plain');
        } finally {
            removePathRecursive(projectRoot);
        }
    });

    it('preserves project-memory user content across update', () => {
        const { projectRoot, bundleRoot, answersPath } = setupUpdateWorkspace(repoRoot);
        try {
            // First update materializes workspace including project-memory seed
            runUpdate({
                targetRoot: projectRoot,
                bundleRoot,
                initAnswersPath: answersPath,
                skipVerify: true,
                skipManifestValidation: true
            });

            // Write user content into project-memory
            const pmDir = path.join(bundleRoot, 'live', 'docs', 'project-memory');
            assert.ok(fs.existsSync(pmDir), 'project-memory must be seeded after first update');
            fs.writeFileSync(path.join(pmDir, 'context.md'),
                '# Project Context\n\n## Domain\n\nB2B logistics SaaS.\n', 'utf8');
            fs.writeFileSync(path.join(pmDir, 'decisions.md'),
                '# Decisions\n\n## ADR-001\n\nUse PostgreSQL for persistence.\n', 'utf8');

            // Second update — user content must survive
            const result2 = runUpdate({
                targetRoot: projectRoot,
                bundleRoot,
                initAnswersPath: answersPath,
                skipVerify: true,
                skipManifestValidation: true
            });

            assert.equal(result2.materializationStatus, 'PASS');
            assert.ok(fs.existsSync(path.join(pmDir, 'context.md')),
                'context.md must survive update');
            assert.ok(fs.readFileSync(path.join(pmDir, 'context.md'), 'utf8')
                .includes('B2B logistics SaaS'),
                'user content must be intact');
            assert.ok(fs.existsSync(path.join(pmDir, 'decisions.md')),
                'decisions.md must survive update');
            assert.ok(fs.readFileSync(path.join(pmDir, 'decisions.md'), 'utf8')
                .includes('PostgreSQL'),
                'decisions content must be intact');
        } finally {
            removePathRecursive(projectRoot);
        }
    });

    it('adds missing project-memory files during update without overwriting preserved files', () => {
        const { projectRoot, bundleRoot, answersPath } = setupUpdateWorkspace(repoRoot);
        try {
            runUpdate({
                targetRoot: projectRoot,
                bundleRoot,
                initAnswersPath: answersPath,
                skipVerify: true,
                skipManifestValidation: true
            });

            const pmDir = path.join(bundleRoot, 'live', 'docs', 'project-memory');
            fs.writeFileSync(path.join(pmDir, 'README.md'), '# Project Memory\n\nCustom operator-owned index.\n', 'utf8');
            fs.writeFileSync(path.join(pmDir, 'context.md'), '# Context\n\n## Domain\n\nKeep this domain.\n', 'utf8');
            fs.rmSync(path.join(pmDir, 'compact.md'), { force: true });
            fs.rmSync(path.join(pmDir, 'module-map.md'), { force: true });

            const result = runUpdate({
                targetRoot: projectRoot,
                bundleRoot,
                initAnswersPath: answersPath,
                skipVerify: true,
                skipManifestValidation: true
            });

            assert.equal(fs.readFileSync(path.join(pmDir, 'README.md'), 'utf8'), '# Project Memory\n\nCustom operator-owned index.\n');
            assert.ok(fs.readFileSync(path.join(pmDir, 'context.md'), 'utf8').includes('Keep this domain.'));
            assert.ok(fs.existsSync(path.join(pmDir, 'compact.md')), 'missing compact.md should be added');
            assert.ok(fs.existsSync(path.join(pmDir, 'module-map.md')), 'missing module-map.md should be added');
            assert.ok(result.projectMemoryDiagnostics, 'update result should expose project-memory diagnostics');
            assert.ok(result.projectMemoryDiagnostics!.copiedFiles.includes('compact.md'));
            assert.ok(result.projectMemoryDiagnostics!.copiedFiles.includes('module-map.md'));
            assert.ok(
                result.projectMemoryDiagnostics!.templateUpdateNotices.some((notice: string) => notice.includes('README.md preserved')),
                'preserved README should surface template guidance notice'
            );

            const reportPath = path.join(projectRoot, result.updateReportPath);
            const report = fs.readFileSync(reportPath, 'utf8');
            assert.ok(report.includes('## ProjectMemory'));
            assert.ok(report.includes('CopiedMissingFiles: compact.md, module-map.md'));
            assert.ok(report.includes('TemplateUpdateNotices: docs/project-memory/README.md preserved'));
        } finally {
            removePathRecursive(projectRoot);
        }
    });

    it('regenerates 15-project-memory.md from user content during update', () => {
        const { projectRoot, bundleRoot, answersPath } = setupUpdateWorkspace(repoRoot);
        try {
            runUpdate({
                targetRoot: projectRoot,
                bundleRoot,
                initAnswersPath: answersPath,
                skipVerify: true,
                skipManifestValidation: true
            });

            // Add user content to project-memory
            const pmDir = path.join(bundleRoot, 'live', 'docs', 'project-memory');
            fs.writeFileSync(path.join(pmDir, 'context.md'),
                '# Project Context\n\n## Domain\n\nEnterprise CRM platform.\n', 'utf8');

            // Second update — summary must regenerate with user content
            runUpdate({
                targetRoot: projectRoot,
                bundleRoot,
                initAnswersPath: answersPath,
                skipVerify: true,
                skipManifestValidation: true
            });

            const summaryPath = path.join(bundleRoot, 'live', 'docs', 'agent-rules', '15-project-memory.md');
            assert.ok(fs.existsSync(summaryPath), '15-project-memory.md must exist after update');
            const content = fs.readFileSync(summaryPath, 'utf8');
            assert.ok(content.includes('DO NOT EDIT'), 'must have DO NOT EDIT header');
            assert.ok(content.includes('Enterprise CRM platform'), 'must include user content');
            assert.ok(content.includes('Provenance'), 'must include provenance table');
            assert.ok(content.includes('docs/project-memory/context.md'), 'provenance must reference source');
        } finally {
            removePathRecursive(projectRoot);
        }
    });

    it('produces valid stub 15-project-memory.md when project-memory has only templates', () => {
        const { projectRoot, bundleRoot, answersPath } = setupUpdateWorkspace(repoRoot);
        try {
            // Single update — project-memory seeded with templates only
            runUpdate({
                targetRoot: projectRoot,
                bundleRoot,
                initAnswersPath: answersPath,
                skipVerify: true,
                skipManifestValidation: true
            });

            const summaryPath = path.join(bundleRoot, 'live', 'docs', 'agent-rules', '15-project-memory.md');
            assert.ok(fs.existsSync(summaryPath), '15-project-memory.md must exist');
            const content = fs.readFileSync(summaryPath, 'utf8');
            assert.ok(content.includes('DO NOT EDIT'));
            assert.ok(
                content.includes('placeholder templates') || content.includes('no content'),
                'stub must indicate placeholder state'
            );
        } finally {
            removePathRecursive(projectRoot);
        }
    });

    it('reports SKIPPED for verify/manifest when skip flags are set even with runners', () => {
        const { projectRoot, bundleRoot, answersPath } = setupUpdateWorkspace(repoRoot);
        try {
            let verifyCalled = false;
            let manifestCalled = false;

            const result = runUpdate({
                targetRoot: projectRoot,
                bundleRoot,
                initAnswersPath: answersPath,
                skipVerify: true,
                skipManifestValidation: true,
                verifyRunner: () => { verifyCalled = true; },
                manifestRunner: () => { manifestCalled = true; }
            });

            assert.ok(!verifyCalled, 'verifyRunner should not be called when skipVerify is true');
            assert.ok(!manifestCalled, 'manifestRunner should not be called when skipManifestValidation is true');
            assert.equal(result.verifyStatus, 'SKIPPED');
            assert.equal(result.manifestValidationStatus, 'SKIPPED');
        } finally {
            removePathRecursive(projectRoot);
        }
    });

    it('preserves ready checkpoints across update and stamps bundle version', () => {
        const { projectRoot, bundleRoot, answersPath } = setupUpdateWorkspace(repoRoot);
        try {
            const bundleVersion = fs.readFileSync(path.join(bundleRoot, 'VERSION'), 'utf8').trim();
            fs.writeFileSync(path.join(bundleRoot, 'runtime', 'agent-init-state.json'), JSON.stringify({
                Version: 1,
                UpdatedAt: '2026-03-31T00:00:00.000Z',
                OrchestratorVersion: bundleVersion,
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

            runUpdate({
                targetRoot: projectRoot,
                bundleRoot,
                initAnswersPath: answersPath,
                skipVerify: true,
                skipManifestValidation: true
            });

            const persistedState = JSON.parse(fs.readFileSync(
                path.join(bundleRoot, 'runtime', 'agent-init-state.json'),
                'utf8'
            ));
            assert.equal(persistedState.OrchestratorVersion, bundleVersion);
            assert.equal(persistedState.ActiveAgentFilesConfirmed, true);
            assert.equal(persistedState.ProjectRulesUpdated, true);
            assert.equal(persistedState.SkillsPromptCompleted, true);
            assert.equal(persistedState.VerificationPassed, true);
            assert.equal(persistedState.ManifestValidationPassed, true);
        } finally {
            removePathRecursive(projectRoot);
        }
    });

    it('passes gitignore-scoping init fields to the update materialization runner', () => {
        const { projectRoot, bundleRoot, answersPath } = setupUpdateWorkspace(repoRoot);
        try {
            fs.writeFileSync(path.join(bundleRoot, 'runtime', 'init-answers.json'), JSON.stringify({
                AssistantLanguage: 'English',
                AssistantBrevity: 'concise',
                SourceOfTruth: 'Claude',
                EnforceNoAutoCommit: 'false',
                ClaudeOrchestratorFullAccess: 'true',
                TokenEconomyEnabled: 'true',
                ProviderMinimalism: 'false',
                CollectedVia: 'CLI_NONINTERACTIVE',
                ActiveAgentFiles: 'CLAUDE.md, AGENTS.md'
            }, null, 2), 'utf8');
            let captured: CapturedMaterializationOptions | undefined;
            let capturedCalled = false;

            const result = runUpdate({
                targetRoot: projectRoot,
                bundleRoot,
                initAnswersPath: answersPath,
                skipVerify: true,
                skipManifestValidation: true,
                materializationRunner: (options) => {
                    captured = options;
                    capturedCalled = true;
                }
            });

            assert.equal(result.materializationStatus, 'PASS');
            assert.equal(capturedCalled, true, 'materializationRunner should receive update-provided init options');
            const capturedOptions = captured!;
            assert.equal(capturedOptions.claudeOrchestratorFullAccess, true);
            assert.equal(capturedOptions.providerMinimalism, false);
            assert.equal(capturedOptions.activeAgentFilesSeed, 'CLAUDE.md, AGENTS.md');
        } finally {
            removePathRecursive(projectRoot);
        }
    });
});

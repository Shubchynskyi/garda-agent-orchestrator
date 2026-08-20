import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
    collectSourceInventory,
    runInit,
    USAGE_CONTRACT_MARKERS
} from '../../../src/materialization/init';
import { getProjectDiscovery } from '../../../src/materialization/project-discovery';
import {
    mergeProfilesConfigWithTemplate,
    runInitConfigStage
} from '../../../src/materialization/init/init-config-stage';
import {
    runInitReportingStage
} from '../../../src/materialization/init/init-reporting-stage';
import {
    runInitRuleStage
} from '../../../src/materialization/init/init-rule-stage';
import { RULE_FILES } from '../../../src/materialization/rule-materialization';

function findRepoRoot(): string {
    let current = __dirname;
    while (current !== path.dirname(current)) {
        if (
            fs.existsSync(path.join(current, 'VERSION'))
            && fs.existsSync(path.join(current, 'template'))
        ) {
            return current;
        }
        current = path.dirname(current);
    }
    throw new Error('Cannot find repo root');
}

function copyDirectoryRecursive(source: string, destination: string): void {
    fs.mkdirSync(destination, { recursive: true });
    for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
        const sourcePath = path.join(source, entry.name);
        const destinationPath = path.join(destination, entry.name);
        if (entry.isDirectory()) {
            copyDirectoryRecursive(sourcePath, destinationPath);
        } else {
            fs.copyFileSync(sourcePath, destinationPath);
        }
    }
}

describe('profile config materialization migration', () => {
    it('preserves legacy remediation policy omission while applying explicit policy to fresh profiles', () => {
        const template = {
            version: 1,
            active_profile: 'balanced',
            built_in_profiles: {
                balanced: {
                    description: 'Balanced',
                    depth: 2,
                    review_remediation_mode_policy: { policy_id: 'conservative_review_remediation_mode_v1' }
                }
            },
            user_profiles: {}
        };
        const legacy = structuredClone(template) as unknown as Record<string, unknown>;
        const legacyBuiltIns = legacy.built_in_profiles as Record<string, Record<string, unknown>>;
        legacyBuiltIns.BALANCED = legacyBuiltIns.balanced;
        delete legacyBuiltIns.balanced;
        delete legacyBuiltIns.BALANCED.review_remediation_mode_policy;

        const migrated = mergeProfilesConfigWithTemplate(template, legacy);
        assert.equal(
            Object.hasOwn(
                (migrated.built_in_profiles as Record<string, Record<string, unknown>>).balanced,
                'review_remediation_mode_policy'
            ),
            false
        );
        const fresh = mergeProfilesConfigWithTemplate(template, null);
        assert.equal(
            ((fresh.built_in_profiles as Record<string, Record<string, unknown>>)
                .balanced.review_remediation_mode_policy as Record<string, unknown>).policy_id,
            'conservative_review_remediation_mode_v1'
        );
    });
});

function createStageWorkspace(repoRoot: string): {
    projectRoot: string;
    bundleRoot: string;
    templateRoot: string;
    liveRoot: string;
} {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-init-stage-'));
    const bundleRoot = path.join(projectRoot, 'garda-agent-orchestrator');
    const templateRoot = path.join(bundleRoot, 'template');
    const liveRoot = path.join(bundleRoot, 'live');
    copyDirectoryRecursive(path.join(repoRoot, 'template'), templateRoot);
    fs.copyFileSync(path.join(repoRoot, 'VERSION'), path.join(bundleRoot, 'VERSION'));
    fs.mkdirSync(path.join(bundleRoot, 'runtime'), { recursive: true });
    fs.mkdirSync(path.join(liveRoot, 'docs', 'agent-rules'), { recursive: true });
    return { projectRoot, bundleRoot, templateRoot, liveRoot };
}

describe('init materialization stages', () => {
    const repoRoot = findRepoRoot();

    it('collects deterministic source-inventory entries through the filesystem contract', () => {
        const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-init-inventory-'));
        try {
            fs.mkdirSync(path.join(projectRoot, 'docs', 'agent-rules'), { recursive: true });
            fs.mkdirSync(path.join(projectRoot, 'docs', 'nested'), { recursive: true });
            fs.writeFileSync(path.join(projectRoot, 'AGENTS.md'), '# Agents\n', 'utf8');
            fs.writeFileSync(
                path.join(projectRoot, 'docs', 'agent-rules', '10-project-context.md'),
                '# Context\n',
                'utf8'
            );
            fs.writeFileSync(
                path.join(projectRoot, 'docs', 'agent-rules', '00-core.md'),
                '# Core\n',
                'utf8'
            );
            fs.writeFileSync(
                path.join(projectRoot, 'docs', 'nested', 'guide.md'),
                '# Guide\n',
                'utf8'
            );
            fs.writeFileSync(
                path.join(projectRoot, 'docs', 'nested', 'ignored.txt'),
                'not markdown\n',
                'utf8'
            );

            const inventory = collectSourceInventory(projectRoot);
            const agentsEntrypoint = inventory.legacyEntrypoints.find(
                (entry) => entry.path === 'AGENTS.md'
            );

            assert.equal(inventory.projectRoot, projectRoot.replace(/\\/g, '/'));
            assert.deepEqual(inventory.legacyRuleFiles, [
                'docs/agent-rules/00-core.md',
                'docs/agent-rules/10-project-context.md'
            ]);
            assert.deepEqual(inventory.docsMarkdownFiles, [
                'docs/agent-rules/00-core.md',
                'docs/agent-rules/10-project-context.md',
                'docs/nested/guide.md'
            ]);
            assert.equal(agentsEntrypoint?.exists, true);
            assert.equal(inventory.docsMarkdownFiles.includes('docs/nested/ignored.txt'), false);
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });

    it('materializes rule and project-memory outputs through the rule-stage contract', () => {
        const workspace = createStageWorkspace(repoRoot);
        try {
            const result = runInitRuleStage({
                targetRoot: workspace.projectRoot,
                bundleRoot: workspace.bundleRoot,
                templateRoot: workspace.templateRoot,
                liveRoot: workspace.liveRoot,
                templateRuleRoot: path.join(workspace.templateRoot, 'docs', 'agent-rules'),
                liveRuleRoot: path.join(workspace.liveRoot, 'docs', 'agent-rules'),
                workflowConfigPath: path.join(workspace.liveRoot, 'config', 'workflow-config.json'),
                dryRun: false,
                timestampIso: '2026-07-26T00:00:00.000Z',
                lang: 'English',
                brevity: 'concise',
                discovery: getProjectDiscovery(workspace.projectRoot),
                preservedCompileGateCommand: null
            });

            assert.equal(result.ruleSourceMap.length, RULE_FILES.length);
            assert.equal(result.copiedSupportDirs, 6);
            assert.equal(result.seededDirs, 1);
            assert.ok(fs.existsSync(path.join(
                workspace.liveRoot,
                'docs',
                'agent-rules',
                '00-core.md'
            )));
            assert.ok(fs.existsSync(path.join(
                workspace.liveRoot,
                'docs',
                'agent-rules',
                '15-project-memory.md'
            )));
            assert.ok(fs.existsSync(result.projectMemoryBootstrapReport.path));
        } finally {
            fs.rmSync(workspace.projectRoot, { recursive: true, force: true });
        }
    });

    it('preserves existing workflow values and applies runtime overrides through the config-stage contract', () => {
        const workspace = createStageWorkspace(repoRoot);
        try {
            const liveConfigRoot = path.join(workspace.liveRoot, 'config');
            fs.mkdirSync(liveConfigRoot, { recursive: true });
            const templateWorkflowConfig = JSON.parse(fs.readFileSync(
                path.join(workspace.templateRoot, 'config', 'workflow-config.json'),
                'utf8'
            )) as Record<string, unknown>;
            const existingWorkflowConfig = {
                ...templateWorkflowConfig,
                custom_stage_fixture: 'preserve-me',
                full_suite_validation: {
                    ...(templateWorkflowConfig.full_suite_validation as Record<string, unknown>),
                    enabled: false
                }
            };
            const workflowConfigPath = path.join(liveConfigRoot, 'workflow-config.json');
            fs.writeFileSync(
                workflowConfigPath,
                JSON.stringify(existingWorkflowConfig, null, 2),
                'utf8'
            );

            const result = runInitConfigStage({
                targetRoot: workspace.projectRoot,
                templateRoot: workspace.templateRoot,
                liveRoot: workspace.liveRoot,
                workflowConfigExistedBeforeRun: true,
                preserveLegacyWorkflowConfigOmission: false,
                discovery: getProjectDiscovery(workspace.projectRoot),
                preservedCompileGateCommand: null,
                tokenEconomyEnabled: false,
                dryRun: false
            });

            const materializedWorkflowConfig = JSON.parse(fs.readFileSync(
                workflowConfigPath,
                'utf8'
            )) as Record<string, unknown>;
            const tokenEconomyConfig = JSON.parse(fs.readFileSync(
                path.join(liveConfigRoot, 'token-economy.json'),
                'utf8'
            )) as Record<string, unknown>;
            assert.equal(materializedWorkflowConfig.custom_stage_fixture, 'preserve-me');
            assert.equal(
                (materializedWorkflowConfig.full_suite_validation as Record<string, unknown>).enabled,
                false
            );
            assert.equal(tokenEconomyConfig.enabled, false);
            assert.match(
                result.configMergeStatuses['workflow-config'],
                /^existing_values_preserved_and_missing_keys_filled /
            );
        } finally {
            fs.rmSync(workspace.projectRoot, { recursive: true, force: true });
        }
    });

    it('materializes reports and control-plane outputs through the reporting-stage contract', () => {
        const workspace = createStageWorkspace(repoRoot);
        try {
            const discovery = getProjectDiscovery(workspace.projectRoot);
            const timestampIso = '2026-07-26T00:00:00.000Z';
            const ruleStage = runInitRuleStage({
                targetRoot: workspace.projectRoot,
                bundleRoot: workspace.bundleRoot,
                templateRoot: workspace.templateRoot,
                liveRoot: workspace.liveRoot,
                templateRuleRoot: path.join(workspace.templateRoot, 'docs', 'agent-rules'),
                liveRuleRoot: path.join(workspace.liveRoot, 'docs', 'agent-rules'),
                workflowConfigPath: path.join(workspace.liveRoot, 'config', 'workflow-config.json'),
                dryRun: false,
                timestampIso,
                lang: 'English',
                brevity: 'concise',
                discovery,
                preservedCompileGateCommand: null
            });
            const configStage = runInitConfigStage({
                targetRoot: workspace.projectRoot,
                templateRoot: workspace.templateRoot,
                liveRoot: workspace.liveRoot,
                workflowConfigExistedBeforeRun: false,
                preserveLegacyWorkflowConfigOmission: false,
                discovery,
                preservedCompileGateCommand: null,
                tokenEconomyEnabled: true,
                dryRun: false
            });

            const result = runInitReportingStage({
                targetRoot: workspace.projectRoot,
                normalizedTarget: path.resolve(workspace.projectRoot),
                bundleRoot: workspace.bundleRoot,
                liveRoot: workspace.liveRoot,
                dryRun: false,
                timestampIso,
                projectName: path.basename(workspace.projectRoot),
                resolvedActiveEntryFiles: ['AGENTS.md'],
                providerOrchestratorProfiles: [],
                claudeOrchestratorFullAccess: false,
                providerMinimalism: true,
                ruleSourceMap: ruleStage.ruleSourceMap,
                copiedSupportDirs: ruleStage.copiedSupportDirs,
                configMergeStatuses: configStage.configMergeStatuses,
                lang: 'English',
                brevity: 'concise',
                trimmedSoT: 'Codex',
                canonicalEntrypoint: 'AGENTS.md',
                enforceNoAutoCommit: false,
                tokenEconomyEnabled: true,
                discovery,
                projectMemoryBootstrapReport: ruleStage.projectMemoryBootstrapReport.report,
                projectMemoryMaintenanceSummaryLine: configStage.projectMemoryMaintenanceSummaryLine,
                optionalQualityChecksNotice: configStage.optionalQualityChecksNotice,
                legacyStyleGuidanceActive: ruleStage.legacyStyleGuidanceActive,
                migrationResult: ruleStage.migrationResult,
                materializedWorkflowConfig: configStage.materializedWorkflowConfig
            });

            assert.ok(fs.existsSync(result.sourceInventoryPath));
            assert.ok(fs.existsSync(result.initReportPath));
            assert.ok(fs.existsSync(result.projectDiscoveryPath));
            assert.ok(fs.existsSync(result.skillsIndexPath));
            assert.match(
                fs.readFileSync(result.usagePath, 'utf8'),
                new RegExp(USAGE_CONTRACT_MARKERS.executeTasks)
            );
            assert.ok(fs.readFileSync(
                path.join(workspace.projectRoot, '.agentignore'),
                'utf8'
            ).includes('garda-agent-orchestrator/runtime/'));
        } finally {
            fs.rmSync(workspace.projectRoot, { recursive: true, force: true });
        }
    });

    it('assembles stage outputs through the runInit coordinator contract', () => {
        const workspace = createStageWorkspace(repoRoot);
        try {
            const result = runInit({
                targetRoot: workspace.projectRoot,
                bundleRoot: workspace.bundleRoot,
                assistantLanguage: 'English',
                assistantBrevity: 'concise',
                sourceOfTruth: 'Codex',
                tokenEconomyEnabled: false
            });

            assert.equal(result.targetRoot, path.resolve(workspace.projectRoot));
            assert.equal(result.ruleFilesMaterialized, RULE_FILES.length);
            assert.equal(result.ruleSourceMap.length, RULE_FILES.length);
            assert.equal(result.tokenEconomyEnabled, false);
            assert.match(
                result.workflowConfigMergeStatus,
                /^live_config_missing_template_applied /
            );
            assert.ok(fs.existsSync(result.initReportPath));
            assert.ok(fs.existsSync(result.projectMemoryBootstrapReportPath));
            assert.ok(fs.existsSync(result.usagePath));
        } finally {
            fs.rmSync(workspace.projectRoot, { recursive: true, force: true });
        }
    });

    it('preserves the workspace through the runInit dry-run contract', () => {
        const workspace = createStageWorkspace(repoRoot);
        try {
            const result = runInit({
                targetRoot: workspace.projectRoot,
                bundleRoot: workspace.bundleRoot,
                assistantLanguage: 'English',
                assistantBrevity: 'concise',
                sourceOfTruth: 'Codex',
                dryRun: true,
                lifecycleLockAlreadyHeld: true
            });
            const materializedPaths = [
                path.join(workspace.projectRoot, 'AGENTS.md'),
                path.join(workspace.projectRoot, '.agentignore'),
                path.join(workspace.liveRoot, 'config'),
                path.join(workspace.liveRoot, 'docs', 'agent-rules', '00-core.md'),
                result.sourceInventoryPath,
                result.initReportPath,
                result.projectDiscoveryPath,
                result.skillsIndexPath,
                result.usagePath,
                result.projectMemoryBootstrapReportPath
            ];

            assert.equal(result.targetRoot, path.resolve(workspace.projectRoot));
            assert.ok(materializedPaths.every((candidatePath) => !fs.existsSync(candidatePath)));
        } finally {
            fs.rmSync(workspace.projectRoot, { recursive: true, force: true });
        }
    });
});

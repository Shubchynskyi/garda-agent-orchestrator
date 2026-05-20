import * as fs from 'node:fs';
import * as path from 'node:path';
import { ensureDirectory, pathExists, readTextFile } from '../core/filesystem';
import { cloneJsonValue, isPlainObject, mergeConfig } from '../core/config-merge';
import { readJsonFile } from '../core/json';
import {
    mergeWorkflowConfigWithTemplate,
    readWorkflowConfigForMerge,
    buildDefaultWorkflowConfig,
    buildWorkflowConfigReviewCycleLimitDiagnostic,
    type WorkflowConfigReadStatus,
    type WorkflowConfigData
} from '../core/workflow-config';
import {
    PROJECT_MEMORY_REFRESH_HANDOFF_PROMPT,
    buildProjectMemoryMaintenanceSummaryLine,
    normalizeProjectMemoryMaintenanceForDisplay
} from '../core/project-memory-rollout';
import {
    buildFullSuiteDisabledGuidance,
    buildNextStepNavigatorGuidance,
    buildTaskStartNavigatorPrompt
} from '../core/onboarding-contract';
import {
    ALL_AGENT_ENTRYPOINT_FILES,
    DEFAULT_ASSISTANT_BREVITY,
    DEFAULT_ASSISTANT_LANGUAGE,
    DEFAULT_SOURCE_OF_TRUTH,
    resolveBundleName
} from '../core/constants';
import { buildSetupStartBannerSentence } from '../core/orchestrator-start-banner';
import { writeProtectedControlPlaneManifest } from '../gates/helpers';
import { syncReviewCapabilities, writeSkillsIndex } from '../runtime/skills';
import {
    getActiveAgentEntrypointFiles,
    getCanonicalEntrypointFile,
    getGitHubSkillBridgeProfileDefinitions,
    getLegacyManagedGitignoreEntries,
    getProviderOrchestratorProfileDefinitions,
    SHARED_START_TASK_WORKFLOW_RELATIVE_PATH
} from './common';
import {
    buildGitignoreEntries,
    syncManagedGitignoreBlockInContent,
    syncManagedAgentignoreActiveBlockInContent
} from './content-builders';
import { getProjectDiscovery, buildProjectDiscoveryLines, buildDiscoveryOverlaySection } from './project-discovery';
import {
    RULE_FILES,
    GENERATED_RULE_FILES,
    isBootstrapOnlyLegacyCodeStyleRule,
    selectRuleSource,
    applyContextDefaults,
    applyAssistantDefaults,
    generateProjectMemorySummary
} from './rule-materialization';
import { getNodeBundleCliCommand, getNodeHumanCommitCommand, getNodeInteractiveUpdateCommand, getNodeNonInteractiveUpdateCommand } from './command-constants';
import { migrateContextRulesToProjectMemory, buildMigrationReportLines } from './project-memory-migration';
import {
    seedProjectMemoryFromTemplate,
    validateSeededProjectMemory,
    writeProjectMemoryBootstrapReport,
    type ProjectMemoryBootstrapReport
} from './project-memory-builder';
import { withLifecycleOperationLock } from '../lifecycle/common';
export { mergeConfig } from '../core/config-merge';

interface RunInitOptions {
    targetRoot: string;
    bundleRoot: string;
    dryRun?: boolean;
    assistantLanguage?: string;
    assistantBrevity?: string;
    sourceOfTruth?: string;
    enforceNoAutoCommit?: boolean;
    claudeOrchestratorFullAccess?: boolean;
    tokenEconomyEnabled?: boolean;
    providerMinimalism?: boolean;
    activeAgentFilesSeed?: string | null;
    preserveLegacyReviewExecutionPolicyOmission?: boolean;
    lifecycleLockAlreadyHeld?: boolean;
}

interface RuleSourceMapEntry {
    ruleFile: string;
    source: string;
    origin: string;
    destination: string;
}

interface SourceInventoryEntry {
    path: string;
    exists: boolean;
}

interface SourceInventory {
    projectRoot: string;
    legacyEntrypoints: SourceInventoryEntry[];
    legacyRuleRoot: string;
    legacyRuleFiles: string[];
    docsMarkdownFiles: string[];
}

type ProjectDiscovery = ReturnType<typeof getProjectDiscovery>;
type ReviewCapabilitiesSyncResult = ReturnType<typeof syncReviewCapabilities>;

function getFullSuiteEnabledDiagnostic(config: Record<string, unknown>): string {
    const fullSuiteSection = isPlainObject(config.full_suite_validation)
        ? config.full_suite_validation
        : null;
    return typeof fullSuiteSection?.enabled === 'boolean'
        ? String(fullSuiteSection.enabled)
        : 'invalid';
}

function getProjectMemoryMaintenanceDiagnostic(config: Record<string, unknown>): { enabled: string; mode: string } {
    const projectMemorySection = isPlainObject(config.project_memory_maintenance)
        ? normalizeProjectMemoryMaintenanceForDisplay(config.project_memory_maintenance)
        : null;
    return {
        enabled: projectMemorySection ? String(projectMemorySection.enabled) : 'invalid',
        mode: projectMemorySection ? String(projectMemorySection.enabled ? projectMemorySection.mode : 'off') : 'invalid'
    };
}

function buildWorkflowConfigMergeStatus(
    targetRoot: string,
    workflowConfigPath: string,
    readStatus: WorkflowConfigReadStatus,
    existingConfig: Record<string, unknown> | null,
    materializedConfig: Record<string, unknown>
): string {
    const relativePath = path.relative(targetRoot, workflowConfigPath).replace(/\\/g, '/');
    const enabledDiagnostic = getFullSuiteEnabledDiagnostic(materializedConfig);
    const projectMemoryDiagnostic = getProjectMemoryMaintenanceDiagnostic(materializedConfig);
    const reviewCycleDiagnostic = buildWorkflowConfigReviewCycleLimitDiagnostic(
        readStatus,
        existingConfig,
        materializedConfig
    );
    const suffix = [
        `path=${relativePath}`,
        `full_suite_validation.enabled=${enabledDiagnostic}`,
        `project_memory_maintenance.enabled=${projectMemoryDiagnostic.enabled}`,
        `project_memory_maintenance.mode=${projectMemoryDiagnostic.mode}`,
        reviewCycleDiagnostic
    ].join(' ');
    if (readStatus === 'present') {
        return `existing_values_preserved_and_missing_keys_filled ${suffix}`;
    }
    return `live_config_${readStatus}_template_applied ${suffix}`;
}

interface BuildInitReportOptions {
    timestampIso: string;
    projectName: string;
    targetRoot: string;
    ruleSourceMap: RuleSourceMapEntry[];
    ruleFiles: readonly string[];
    copiedSupportDirs: number;
    configMergeStatuses: Record<string, string>;
    lang: string;
    brevity: string;
    trimmedSoT: string;
    enforceNoAutoCommit: boolean;
    tokenEconomyEnabled: boolean;
    discovery: ProjectDiscovery;
    sourceInventory: SourceInventory;
    reviewCapabilitiesSync: ReviewCapabilitiesSyncResult | null;
    projectMemoryBootstrapReport: ProjectMemoryBootstrapReport;
    projectMemoryMaintenanceSummaryLine: string;
    projectMemoryRefreshHandoffPrompt: string;
    legacyStyleGuidanceActive?: boolean;
}

interface BuildUsageOptions {
    lang: string;
    brevity: string;
    canonicalEntrypoint: string;
    enforceNoAutoCommit: boolean;
    fullSuiteValidationEnabled: boolean;
}

export function runInit(options: RunInitOptions) {
    const {
        targetRoot,
        bundleRoot,
        dryRun = false,
        assistantLanguage = DEFAULT_ASSISTANT_LANGUAGE,
        assistantBrevity = DEFAULT_ASSISTANT_BREVITY,
        sourceOfTruth = DEFAULT_SOURCE_OF_TRUTH,
        enforceNoAutoCommit = false,
        claudeOrchestratorFullAccess = false,
        tokenEconomyEnabled = true,
        providerMinimalism = true,
        activeAgentFilesSeed = null,
        preserveLegacyReviewExecutionPolicyOmission = false,
        lifecycleLockAlreadyHeld = false
    } = options;

    const templateRoot = path.join(bundleRoot, 'template');
    const liveRoot = path.join(bundleRoot, 'live');
    const templateRuleRoot = path.join(templateRoot, 'docs/agent-rules');
    const liveRuleRoot = path.join(liveRoot, 'docs/agent-rules');
    const workflowConfigPath = path.join(liveRoot, 'config', 'workflow-config.json');
    const workflowConfigExistedBeforeRun = pathExists(workflowConfigPath);
    const preserveLegacyWorkflowConfigOmission = (
        preserveLegacyReviewExecutionPolicyOmission
        && !workflowConfigExistedBeforeRun
    );

    if (!pathExists(templateRoot)) {
        throw new Error(`Template directory not found: ${templateRoot}`);
    }

    // Validate target root
    const normalizedTarget = path.resolve(targetRoot);
    const normalizedBundle = path.resolve(bundleRoot);
    if (normalizedTarget.toLowerCase() === normalizedBundle.toLowerCase()) {
        throw new Error(
            `TargetRoot points to orchestrator bundle directory '${bundleRoot}'. Use the project root parent directory instead.`
        );
    }
    const runWithLock = <T>(callback: () => T): T => lifecycleLockAlreadyHeld
        ? callback()
        : withLifecycleOperationLock(normalizedTarget, 'init', callback);

    return runWithLock(() => {
    const projectName = path.basename(normalizedTarget);
    const timestampIso = new Date().toISOString();
    let gitignoreEntriesAdded = 0;

    // Normalize parameters
    const lang = (assistantLanguage || DEFAULT_ASSISTANT_LANGUAGE).trim() || DEFAULT_ASSISTANT_LANGUAGE;
    let brevity = (assistantBrevity || DEFAULT_ASSISTANT_BREVITY).trim().toLowerCase();
    if (!['concise', 'detailed'].includes(brevity)) {
        throw new Error(`Unsupported AssistantBrevity value '${brevity}'. Allowed values: concise, detailed.`);
    }
    const trimmedSoT = (sourceOfTruth || DEFAULT_SOURCE_OF_TRUTH).trim();
    const canonicalEntrypoint = getCanonicalEntrypointFile(trimmedSoT);
    const activeEntryFiles = getActiveAgentEntrypointFiles(activeAgentFilesSeed, trimmedSoT);
    const resolvedActiveEntryFiles = activeEntryFiles.length > 0 ? activeEntryFiles : [canonicalEntrypoint];
    const providerOrchestratorProfiles = getProviderOrchestratorProfileDefinitions().filter(
        (profile) => resolvedActiveEntryFiles.includes(profile.entrypointFile)
    );

    // Ensure live directories
    if (!dryRun) {
        ensureDirectory(liveRoot);
        ensureDirectory(liveRuleRoot);
    }

    // Project discovery
    const discovery = getProjectDiscovery(targetRoot);
    const discoveryLines = buildProjectDiscoveryLines(discovery, timestampIso);
    const discoveryOverlay = buildDiscoveryOverlaySection(discovery);

    // Seed project-memory from template and add later missing seed files without overwriting user content.
    const projectMemorySeed = seedProjectMemoryFromTemplate({ templateRoot, liveRoot, dryRun });
    const seededDirs = projectMemorySeed.seededDirectory ? 1 : 0;

    // T-075: migrate user-authored content from context rules into project-memory
    // (runs BEFORE rule materialization so current live/legacy content is still readable)
    const migrationResult = migrateContextRulesToProjectMemory({
        bundleRoot, targetRoot, templateRoot, dryRun
    });

    // Materialize rule files
    const ruleSourceMap: RuleSourceMapEntry[] = [];
    let legacyStyleGuidanceActive = false;

    for (const ruleFile of RULE_FILES) {
        if (GENERATED_RULE_FILES.includes(ruleFile)) continue;

        let source = selectRuleSource(ruleFile, { targetRoot, liveRuleRoot, templateRuleRoot });
        if (!source) {
            throw new Error(`No source found for rule file: ${ruleFile}`);
        }

        if (
            ruleFile === '30-code-style.md'
            && migrationResult.status === 'project_memory_has_content'
            && source.origin !== 'template'
        ) {
            const templatePath = path.join(templateRuleRoot, ruleFile);
            if (pathExists(templatePath)) {
                const templateContent = readTextFile(templatePath);
                const candidateContent = readTextFile(source.path);
                if (!isBootstrapOnlyLegacyCodeStyleRule(candidateContent, templateContent)) {
                    legacyStyleGuidanceActive = true;
                }
            }
        }

        let content = readTextFile(source.path);
        if (!content || !content.trim()) {
            throw new Error(`Rule source is empty: ${source.path}`);
        }

        // Apply template-specific context overlay
        if (source.origin === 'template') {
            content = applyContextDefaults(content, ruleFile, discoveryOverlay);
        }

        // Apply assistant defaults (language/brevity) to 00-core.md
        content = applyAssistantDefaults(content, ruleFile, lang, brevity);

        const destPath = path.join(liveRuleRoot, ruleFile);
        if (!dryRun) {
            fs.writeFileSync(destPath, content, 'utf8');
        }

        ruleSourceMap.push({
            ruleFile,
            source: path.relative(targetRoot, source.path).replace(/\\/g, '/'),
            origin: source.origin,
            destination: path.relative(targetRoot, destPath).replace(/\\/g, '/')
        });
    }

    const managedConfigNames = ['review-capabilities', 'paths', 'token-economy', 'output-filters', 'skill-packs', 'optional-skill-selection-policy', 'isolation-mode', 'profiles', 'review-artifact-storage', 'workflow-config', 'garda.config'];
    const managedConfigFileNames = new Set(managedConfigNames.map((configName) => `${configName}.json`.toLowerCase()));

    // Scaffold new style templates if on legacy guidance
    if (legacyStyleGuidanceActive && !dryRun) {
        const styleTemplatePath = path.join(templateRuleRoot, '30-code-style.md');
        if (pathExists(styleTemplatePath)) {
            fs.writeFileSync(path.join(liveRuleRoot, '30-code-style.template.md'), readTextFile(styleTemplatePath), 'utf8');
        }
        
        const conventionsTemplatePath = path.join(templateRoot, 'docs/project-memory/conventions.md');
        if (pathExists(conventionsTemplatePath)) {
            const projectMemoryDir = path.join(liveRoot, 'docs/project-memory');
            ensureDirectory(projectMemoryDir);
            const conventionsScaffoldPath = path.join(projectMemoryDir, 'conventions.template.md');
            if (!pathExists(conventionsScaffoldPath)) {
                fs.writeFileSync(conventionsScaffoldPath, readTextFile(conventionsTemplatePath), 'utf8');
            }
            const markerPath = path.join(projectMemoryDir, '.legacy-style-contract');
            if (!pathExists(markerPath)) {
                fs.writeFileSync(markerPath, 'This workspace retains legacy code-style conventions. Review conventions.template.md to adopt the updated contract.', 'utf8');
            }
        }
    }

    // Copy support directories from template to live
    const supportDirectories = [
        'config', 'skills', 'docs/changes', 'docs/reviews', 'docs/tasks'
    ];
    let copiedSupportDirs = 0;

    for (const relDir of supportDirectories) {
        const srcDir = path.join(templateRoot, relDir);
        if (!pathExists(srcDir)) continue;

        const destDir = path.join(liveRoot, relDir);
        if (!dryRun) {
            ensureDirectory(destDir);
            copyDirectoryRecursive(
                srcDir,
                destDir,
                relDir === 'config'
                    ? {
                        shouldCopyFile: (_srcPath, destPath) => !(
                            managedConfigFileNames.has(path.basename(destPath).toLowerCase())
                            && pathExists(destPath)
                        )
                    }
                    : undefined
            );
        }
        copiedSupportDirs++;
    }

    // Generate project-memory summary rule (always regenerated, after migration)
    const projectMemoryDir = projectMemorySeed.projectMemoryDir;
    const projectMemorySummary = generateProjectMemorySummary(projectMemoryDir, timestampIso);
    const projectMemorySummaryDest = path.join(liveRuleRoot, '15-project-memory.md');
    if (!dryRun) {
        fs.writeFileSync(projectMemorySummaryDest, projectMemorySummary, 'utf8');
    }
    ruleSourceMap.push({
        ruleFile: '15-project-memory.md',
        source: 'docs/project-memory/*',
        origin: 'generated',
        destination: path.relative(targetRoot, projectMemorySummaryDest).replace(/\\/g, '/')
    });

    const projectMemoryValidation = validateSeededProjectMemory(projectMemorySeed, { mode: 'check' });
    const projectMemoryBootstrapReport = writeProjectMemoryBootstrapReport({
        bundleRoot,
        timestampIso,
        seedResult: projectMemorySeed,
        validation: projectMemoryValidation,
        summaryPath: projectMemorySummaryDest,
        dryRun
    });

    // Handle managed config materialization (token-economy enabled flag)
    const configMergeStatuses: Record<string, string> = {};
    let projectMemoryMaintenanceSummaryLine = buildProjectMemoryMaintenanceSummaryLine(
        buildDefaultWorkflowConfig().project_memory_maintenance
    );
    let materializedWorkflowConfig: Record<string, unknown> = buildDefaultWorkflowConfig();

    for (const configName of managedConfigNames) {
        const templateConfigPath = path.join(templateRoot, `config/${configName}.json`);
        const destConfigPath = path.join(liveRoot, `config/${configName}.json`);

        if (!pathExists(templateConfigPath)) {
            configMergeStatuses[configName] = 'template_missing_preservation_skipped';
            continue;
        }

        try {
            const templateConfig = cloneJsonValue(readJsonFile(templateConfigPath) as Record<string, unknown>);
            let existingConfig: Record<string, unknown> | null = null;
            let workflowConfigReadStatus: WorkflowConfigReadStatus = 'missing';
            const treatWorkflowConfigAsMissingBeforeRun = (
                configName === 'workflow-config'
                && preserveLegacyWorkflowConfigOmission
            );
            const hadExistingConfig = treatWorkflowConfigAsMissingBeforeRun
                ? false
                : pathExists(destConfigPath);

            if (configName === 'workflow-config') {
                if (treatWorkflowConfigAsMissingBeforeRun || !workflowConfigExistedBeforeRun) {
                    workflowConfigReadStatus = 'missing';
                    existingConfig = null;
                } else {
                    const readResult = readWorkflowConfigForMerge(destConfigPath);
                    workflowConfigReadStatus = readResult.status;
                    existingConfig = readResult.config;
                }
            } else if (hadExistingConfig) {
                try {
                    const parsedExistingConfig = readJsonFile(destConfigPath);
                    existingConfig = isPlainObject(parsedExistingConfig)
                        ? parsedExistingConfig
                        : null;
                } catch {
                    existingConfig = null;
                }
            }

            const replaceWithCanonicalTemplate = configName === 'garda.config';
            const materializedConfig = replaceWithCanonicalTemplate
                ? cloneJsonValue(templateConfig)
                : configName === 'workflow-config'
                    ? mergeWorkflowConfigWithTemplate(templateConfig as WorkflowConfigData, existingConfig, {
                        preserveLegacyReviewExecutionPolicyOmission: preserveLegacyWorkflowConfigOmission
                    })
                    : mergeConfig(templateConfig, existingConfig);

            // Apply token economy enabled flag
            if (configName === 'token-economy') {
                materializedConfig.enabled = tokenEconomyEnabled;
            }
            if (configName === 'workflow-config') {
                materializedWorkflowConfig = materializedConfig;
                projectMemoryMaintenanceSummaryLine = buildProjectMemoryMaintenanceSummaryLine(
                    normalizeProjectMemoryMaintenanceForDisplay(materializedConfig.project_memory_maintenance)
                );
            }

            if (!dryRun) {
                const json = JSON.stringify(materializedConfig, null, 2);
                ensureDirectory(path.dirname(destConfigPath));
                fs.writeFileSync(destConfigPath, json, 'utf8');
            }

            configMergeStatuses[configName] = configName === 'workflow-config'
                ? buildWorkflowConfigMergeStatus(targetRoot, destConfigPath, workflowConfigReadStatus, existingConfig, materializedConfig)
                : replaceWithCanonicalTemplate
                    ? (hadExistingConfig
                        ? 'canonical_template_reapplied_existing_values_replaced'
                        : 'canonical_template_applied')
                    : (existingConfig
                        ? 'existing_values_preserved_and_missing_keys_filled'
                        : 'no_existing_live_config_template_applied');
        } catch (err) {
            configMergeStatuses[configName] = 'merge_failed_template_applied';
        }
    }

    // Write reporting files
    const sourceInventoryPath = path.join(liveRoot, 'source-inventory.md');
    const initReportPath = path.join(liveRoot, 'init-report.md');
    const projectDiscoveryPath = path.join(liveRoot, 'project-discovery.md');
    const usagePath = path.join(liveRoot, 'USAGE.md');
    const skillsIndexPath = path.join(liveRoot, 'config', 'skills-index.json');
    const gitignorePath = path.join(normalizedTarget, '.gitignore');
    const agentignorePath = path.join(normalizedTarget, '.agentignore');
    let agentignoreUpdated = false;
    const sourceInventory = collectSourceInventory(targetRoot);
    const reviewCapabilitiesSync = dryRun ? null : syncReviewCapabilities(bundleRoot);
    const gitignoreEntries = buildGitignoreEntries(
        resolvedActiveEntryFiles,
        providerOrchestratorProfiles,
        claudeOrchestratorFullAccess,
        pathExists(path.join(normalizedTarget, '.qwen', 'settings.json')),
        providerMinimalism
    );

    if (!dryRun) {
        const existingGitignoreContent = pathExists(gitignorePath) ? readTextFile(gitignorePath) : '';
        const gitignoreSync = syncManagedGitignoreBlockInContent(
            existingGitignoreContent,
            gitignoreEntries,
            claudeOrchestratorFullAccess
        );
        gitignoreEntriesAdded = gitignoreSync.addedEntries;
        if (gitignoreSync.changed) {
            fs.writeFileSync(gitignorePath, gitignoreSync.content, 'utf8');
        }
        const existingAgentignoreContent = pathExists(agentignorePath) ? readTextFile(agentignorePath) : '';
        const agentignoreSync = syncManagedAgentignoreActiveBlockInContent(
            existingAgentignoreContent,
            path.basename(bundleRoot)
        );
        if (agentignoreSync.changed) {
            fs.writeFileSync(agentignorePath, agentignoreSync.content, 'utf8');
            agentignoreUpdated = true;
        }
    } else {
        const existingGitignoreContent = pathExists(gitignorePath) ? readTextFile(gitignorePath) : '';
        gitignoreEntriesAdded = syncManagedGitignoreBlockInContent(
            existingGitignoreContent,
            gitignoreEntries,
            claudeOrchestratorFullAccess
        ).addedEntries;
        const existingAgentignoreContent = pathExists(agentignorePath) ? readTextFile(agentignorePath) : '';
        agentignoreUpdated = syncManagedAgentignoreActiveBlockInContent(
            existingAgentignoreContent,
            path.basename(bundleRoot)
        ).changed;
    }

    if (!dryRun) {
        // Source inventory
        const inventoryLines = buildSourceInventoryLines(sourceInventory, timestampIso);
        fs.writeFileSync(sourceInventoryPath, inventoryLines.join('\r\n'), 'utf8');

        // Init report (including T-075 migration details)
        const initReportLines = buildInitReportLines({
            timestampIso, projectName, targetRoot, ruleSourceMap,
            ruleFiles: RULE_FILES, copiedSupportDirs,
            configMergeStatuses, lang, brevity, trimmedSoT,
            enforceNoAutoCommit, tokenEconomyEnabled, discovery,
            sourceInventory,
            reviewCapabilitiesSync,
            projectMemoryBootstrapReport: projectMemoryBootstrapReport.report,
            projectMemoryMaintenanceSummaryLine,
            projectMemoryRefreshHandoffPrompt: PROJECT_MEMORY_REFRESH_HANDOFF_PROMPT,
            legacyStyleGuidanceActive
        });
        initReportLines.push(...buildMigrationReportLines(migrationResult));
        fs.writeFileSync(initReportPath, initReportLines.join('\r\n'), 'utf8');

        // Project discovery
        fs.writeFileSync(projectDiscoveryPath, discoveryLines.join('\r\n'), 'utf8');

        // Usage (seed if not present)
        if (!pathExists(usagePath)) {
            const usageLines = buildUsageLines({
                lang,
                brevity,
                canonicalEntrypoint,
                enforceNoAutoCommit,
                fullSuiteValidationEnabled: getFullSuiteEnabledDiagnostic(materializedWorkflowConfig) === 'true'
            });
            fs.writeFileSync(usagePath, usageLines.join('\r\n'), 'utf8');
        }

        writeSkillsIndex(bundleRoot);
        writeProtectedControlPlaneManifest(normalizedTarget);
    }

    return {
        targetRoot: normalizedTarget,
        projectName,
        liveRoot,
        assistantLanguage: lang,
        assistantBrevity: brevity,
        sourceOfTruth: trimmedSoT,
        enforceNoAutoCommit,
        claudeOrchestratorFullAccess,
        tokenEconomyEnabled,
        providerMinimalism,
        activeAgentFiles: resolvedActiveEntryFiles,
        gitignoreEntriesAdded,
        agentignoreUpdated,
        ruleFilesMaterialized: RULE_FILES.length,
        supportDirectoriesSynced: copiedSupportDirs,
        seedOnlyDirectoriesSeeded: seededDirs,
        projectMemoryMigration: migrationResult,
        projectMemoryBootstrapReportPath: projectMemoryBootstrapReport.path,
        projectMemoryBootstrapReport: projectMemoryBootstrapReport.report,
        projectMemoryMaintenanceSummaryLine,
        projectMemoryRefreshHandoffPrompt: PROJECT_MEMORY_REFRESH_HANDOFF_PROMPT,
        projectMemoryValidation,
        reviewCapabilitiesConfigMergeStatus: configMergeStatuses['review-capabilities'] || 'n/a',
        pathsConfigMergeStatus: configMergeStatuses['paths'] || 'n/a',
        tokenEconomyConfigMergeStatus: configMergeStatuses['token-economy'] || 'n/a',
        outputFiltersConfigMergeStatus: configMergeStatuses['output-filters'] || 'n/a',
        skillPacksConfigMergeStatus: configMergeStatuses['skill-packs'] || 'n/a',
        optionalSkillSelectionPolicyConfigMergeStatus: configMergeStatuses['optional-skill-selection-policy'] || 'n/a',
        isolationModeConfigMergeStatus: configMergeStatuses['isolation-mode'] || 'n/a',
        profilesConfigMergeStatus: configMergeStatuses['profiles'] || 'n/a',
        reviewArtifactStorageConfigMergeStatus: configMergeStatuses['review-artifact-storage'] || 'n/a',
        workflowConfigMergeStatus: configMergeStatuses['workflow-config'] || 'n/a',
        gardaConfigMergeStatus: configMergeStatuses['garda.config'] || 'n/a',
        reviewCapabilitiesSync,
        skillsIndexPath,
        ruleSourceMap,
        sourceInventoryPath,
        initReportPath,
        projectDiscoveryPath,
        usagePath
    };
    });
}

interface CopyDirectoryOptions {
    shouldCopyFile?: (srcPath: string, destPath: string) => boolean;
}

function copyDirectoryRecursive(srcDir: string, destDir: string, options?: CopyDirectoryOptions): void {
    ensureDirectory(destDir);
    const entries = fs.readdirSync(srcDir, { withFileTypes: true });
    for (const entry of entries) {
        const srcPath = path.join(srcDir, entry.name);
        const destPath = path.join(destDir, entry.name);
        if (entry.isDirectory()) {
            copyDirectoryRecursive(srcPath, destPath, options);
        } else {
            if (options?.shouldCopyFile && !options.shouldCopyFile(srcPath, destPath)) {
                continue;
            }
            fs.copyFileSync(srcPath, destPath);
        }
    }
}

function collectMarkdownFiles(rootPath: string, targetRoot: string): string[] {
    if (!pathExists(rootPath)) {
        return [];
    }

    const discovered: string[] = [];
    const stack: string[] = [rootPath];

    while (stack.length > 0) {
        const currentPath = stack.pop();
        if (!currentPath) {
            continue;
        }
        const entries = fs.readdirSync(currentPath, { withFileTypes: true });

        for (const entry of entries) {
            const fullPath = path.join(currentPath, entry.name);
            if (entry.isDirectory()) {
                stack.push(fullPath);
                continue;
            }

            if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== '.md') {
                continue;
            }

            discovered.push(path.relative(targetRoot, fullPath).replace(/\\/g, '/'));
        }
    }

    return discovered.sort();
}

export function collectSourceInventory(targetRoot: string): SourceInventory {
    const entrypointCandidates = new Set([
        ...ALL_AGENT_ENTRYPOINT_FILES,
        'TASK.md',
        SHARED_START_TASK_WORKFLOW_RELATIVE_PATH,
        '.qwen/settings.json',
        ...getLegacyManagedGitignoreEntries()
    ]);

    for (const profile of getProviderOrchestratorProfileDefinitions()) {
        entrypointCandidates.add(profile.orchestratorRelativePath);
    }
    for (const profile of getGitHubSkillBridgeProfileDefinitions()) {
        entrypointCandidates.add(profile.relativePath);
    }

    const sortedEntrypoints = [...entrypointCandidates].sort();
    const legacyRuleRoot = path.join(targetRoot, 'docs', 'agent-rules');
    const docsRoot = path.join(targetRoot, 'docs');

    return {
        projectRoot: targetRoot.replace(/\\/g, '/'),
        legacyEntrypoints: sortedEntrypoints.map((relativePath) => ({
            path: relativePath.replace(/\\/g, '/'),
            exists: pathExists(path.join(targetRoot, relativePath))
        })),
        legacyRuleRoot: 'docs/agent-rules',
        legacyRuleFiles: collectMarkdownFiles(legacyRuleRoot, targetRoot),
        docsMarkdownFiles: collectMarkdownFiles(docsRoot, targetRoot)
    };
}

function buildSourceInventoryLines(inventory: SourceInventory, timestampIso: string): string[] {
    return [
        '# Source Inventory', '',
        `Generated at: ${timestampIso}`,
        `Project root: ${inventory.projectRoot}`, '',
        '## Legacy Entrypoints',
        ...inventory.legacyEntrypoints.map((entry) => `- \`${entry.path}\` : ${entry.exists ? 'FOUND' : 'MISSING'}`),
        '',
        '## Legacy Rule Sources',
        `- \`${inventory.legacyRuleRoot}\` : ${inventory.legacyRuleFiles.length > 0 ? 'FOUND' : 'MISSING'} (files=${inventory.legacyRuleFiles.length})`,
        ...inventory.legacyRuleFiles.slice(0, 20).map((filePath) => `- \`${filePath}\``),
        '',
        '## Documentation Snapshot',
        `- Markdown files in \`docs/\`: ${inventory.docsMarkdownFiles.length}`,
        ...inventory.docsMarkdownFiles.slice(0, 20).map((filePath) => `- \`${filePath}\``)
    ];
}

function buildInitReportLines(opts: BuildInitReportOptions): string[] {
    const { timestampIso, projectName, targetRoot, ruleSourceMap, ruleFiles,
        copiedSupportDirs, configMergeStatuses, lang, brevity, trimmedSoT,
        enforceNoAutoCommit, tokenEconomyEnabled, discovery,
        sourceInventory, reviewCapabilitiesSync, projectMemoryBootstrapReport,
        projectMemoryMaintenanceSummaryLine, projectMemoryRefreshHandoffPrompt,
        legacyStyleGuidanceActive } = opts;
    const normalized = targetRoot.replace(/\\/g, '/');
    const tick = '`';
    const stackSummary = discovery.detectedStacks.length > 0
        ? discovery.detectedStacks.join(', ') : 'none detected';
    const dirSummary = discovery.topLevelDirectories.length > 0
        ? discovery.topLevelDirectories.slice(0, 10).join(', ') : 'none detected';
    const enabledOptionalReviews = reviewCapabilitiesSync
        ? Object.entries(reviewCapabilitiesSync.capabilities)
            .filter(([key, enabled]) => !['code', 'db', 'security', 'refactor'].includes(key) && enabled)
            .map(([key]) => key)
            .sort()
        : [];

    const lines = [
        '# Init Report', '',
        `Generated at: ${timestampIso}`,
        `Project: ${projectName}`,
        `Target root: ${normalized}`, '',
        '## Summary',
        `- Rule files materialized in ${tick}${resolveBundleName()}/live/docs/agent-rules${tick}: ${ruleFiles.length}`,
        `- Support directories synced into ${tick}${resolveBundleName()}/live${tick}: ${copiedSupportDirs}`,
        '- Review capabilities config sync policy: preserve existing live values, normalize legacy keys/shapes, and fill missing keys from template.',
        `- Review capabilities config merge status: ${configMergeStatuses['review-capabilities'] || 'n/a'}`,
        '- Paths config sync policy: preserve existing live values, normalize legacy keys/shapes, and fill missing keys from template.',
        `- Paths config merge status: ${configMergeStatuses['paths'] || 'n/a'}`,
        '- Token economy config sync policy: preserve existing live values, normalize legacy keys/shapes, and fill missing keys from template.',
        `- Token economy config merge status: ${configMergeStatuses['token-economy'] || 'n/a'}`,
        '- Output filters config sync policy: preserve existing live values, normalize legacy keys/shapes, and fill missing keys from template.',
        `- Output filters config merge status: ${configMergeStatuses['output-filters'] || 'n/a'}`,
        '- Skill packs config sync policy: preserve existing live values, normalize legacy keys/shapes, and fill missing keys from template.',
        `- Skill packs config merge status: ${configMergeStatuses['skill-packs'] || 'n/a'}`,
        '- Optional skill selection policy config sync policy: preserve existing live values and fill missing keys from template.',
        `- Optional skill selection policy config merge status: ${configMergeStatuses['optional-skill-selection-policy'] || 'n/a'}`,
        '- Isolation mode config sync policy: preserve existing live values, fill missing keys from template.',
        `- Isolation mode config merge status: ${configMergeStatuses['isolation-mode'] || 'n/a'}`,
        '- Profiles config sync policy: preserve existing live values and user profiles, fill missing keys from template.',
        `- Profiles config merge status: ${configMergeStatuses['profiles'] || 'n/a'}`,
        '- Review artifact storage config sync policy: preserve existing live values, fill missing keys from template.',
        `- Review artifact storage config merge status: ${configMergeStatuses['review-artifact-storage'] || 'n/a'}`,
        '- Workflow config sync policy: preserve existing live values, fill missing keys from template; if the live file is missing, malformed, or non-object, apply template defaults and report the effective full-suite setting.',
        `- Workflow config merge status: ${configMergeStatuses['workflow-config'] || 'n/a'}`,
        '- Root config manifest sync policy: rewrite the canonical root manifest from template on every init/update.',
        `- Root config manifest merge status: ${configMergeStatuses['garda.config'] || 'n/a'}`,
        `- Assistant response language: ${lang}`,
        `- Assistant response brevity: ${brevity}`,
        `- Source of truth entrypoint: ${trimmedSoT}`,
        `- Hard no-auto-commit guard: ${enforceNoAutoCommit ? 'enabled' : 'disabled'}`,
        `- Token economy mode: ${tokenEconomyEnabled ? 'enabled' : 'disabled'}`,
        `- Project discovery source: ${discovery.source}`,
        `- Project discovery stack signals: ${stackSummary}`,
        `- Project discovery top-level directories: ${dirSummary}`,
        `- Legacy docs discovered in \`docs/agent-rules\`: ${sourceInventory.legacyRuleFiles.length} files`,
        `- Optional review capabilities enabled from live skills: ${enabledOptionalReviews.length > 0 ? enabledOptionalReviews.join(', ') : 'none'}`,
        '- Project memory sync policy: add missing seed files only; preserve existing user-owned files without overwrite.',
        `- ${projectMemoryMaintenanceSummaryLine}`,
        `- Project memory init/refresh prompt: ${projectMemoryRefreshHandoffPrompt}`,
        `- Project memory copied missing files: ${projectMemoryBootstrapReport.seed.copied_files.length > 0 ? projectMemoryBootstrapReport.seed.copied_files.join(', ') : 'none'}`,
        `- Project memory preserved files: ${projectMemoryBootstrapReport.seed.preserved_files.length}`,
        `- Project memory template update notices: ${projectMemoryBootstrapReport.seed.template_update_notices.length}`,
        '- Contract migration snippets auto-applied: 0',
        '- No files were moved or deleted; discovery sources were read-only.', '',
        '## Rule Source Mapping',
        '| Rule file | Source | Origin | Destination |',
        '|---|---|---|---|'
    ];

    for (const item of ruleSourceMap) {
        lines.push(`| ${item.ruleFile} | ${tick}${item.source}${tick} | ${item.origin} | ${tick}${item.destination}${tick} |`);
    }

    lines.push('', '## Context Fill Policy');
    lines.push('- Project-context rules (`10/20/30/40/50/60`) prefer legacy `docs/agent-rules/*`, then existing `live` content, then template defaults.');
    lines.push('- All other rules prefer existing `live` content, then template defaults, then legacy docs fallback.');
    lines.push(`- Selected source-of-truth entrypoint (${tick}${trimmedSoT}${tick}) is provided by installer and points to ${tick}${resolveBundleName()}/live/docs/agent-rules/*${tick}.`);

    if (legacyStyleGuidanceActive) {
        lines.push('', '## Update Notices');
        lines.push('- **Style Guidance Update**: A new style contract is available, but was not applied because `docs/project-memory/` already has content and your `30-code-style.md` contains custom rules.');
        lines.push(`- The updated templates have been scaffolded as ${tick}${resolveBundleName()}/live/docs/agent-rules/30-code-style.template.md${tick} and ${tick}${resolveBundleName()}/live/docs/project-memory/conventions.template.md${tick}.`);
        lines.push('- Review them and manually update your code style or project memory to adopt the new contract. Delete the `.legacy-style-contract` marker when done.');
    }

    if (projectMemoryBootstrapReport.seed.template_update_notices.length > 0) {
        lines.push('', '## Project Memory Update Notices');
        lines.push(`- Existing files under ${tick}${resolveBundleName()}/live/docs/project-memory${tick} are user-owned and were preserved.`);
        lines.push('- Template guidance changed for the files below; review manually if you want to adopt the new guidance.');
        for (const notice of projectMemoryBootstrapReport.seed.template_update_notices) {
            lines.push(`- ${tick}${notice.livePath}${tick} preserved; compare with template ${tick}${notice.templatePath}${tick}.`);
        }
    }

    return lines;
}

function buildUsageLines(opts: BuildUsageOptions): string[] {
    const { lang, brevity, canonicalEntrypoint, enforceNoAutoCommit, fullSuiteValidationEnabled } = opts;
    const cliCommand = getNodeBundleCliCommand();
    const commitGuardLine = enforceNoAutoCommit
        ? `Hard no-auto-commit guard is enabled. It blocks detected agent-session commits while normal human commits remain available; for intentional manual commits from the same agent shell use: \`${getNodeHumanCommitCommand()}\`.`
        : 'Hard no-auto-commit guard is disabled.';
    const fullSuiteLine = fullSuiteValidationEnabled
        ? '- Mandatory full-suite validation is enabled through `garda-agent-orchestrator/live/config/workflow-config.json`; `next-step` routes `full-suite-validation` with the configured command when required.'
        : `- ${buildFullSuiteDisabledGuidance(cliCommand)}`;

    return [
        '# Usage Instructions', '',
        'Path: `garda-agent-orchestrator/live/USAGE.md`', '',
        `Language: ${lang}`,
        `Default response brevity: ${brevity}`, '',
        '## Execute Tasks',
        'Start by selecting a row from root `TASK.md` and tell the agent:',
        `- ${buildTaskStartNavigatorPrompt()}`,
        `- ${buildNextStepNavigatorGuidance(cliCommand)}`,
        `- ${buildSetupStartBannerSentence()}`,
        '- `next-step` owns the executable gate order. Static gate lists are policy context, not commands to guess by hand.',
        '- When independent review is required, launch a fresh sub-agent using your provider/internal tools and record the review only through Garda review gates.', '',
        '## Profiles And Config',
        '- Active profile selection comes from `garda-agent-orchestrator/live/config/profiles.json`; the root `TASK.md` `Profile` column may override it per task, while `default` inherits the workspace active profile.',
        '- Inspect profiles with `node garda-agent-orchestrator/bin/garda.js profile current --target-root "."` or `profile list`; switch with `profile use <name>`; create a user profile with `profile create <name> ...`.',
        '- Review execution modes live in `garda-agent-orchestrator/live/config/workflow-config.json`; inspect with `node garda-agent-orchestrator/bin/garda.js workflow show --target-root "."` and explain with `workflow explain`.',
        '- Optional review capabilities live in `garda-agent-orchestrator/live/config/review-capabilities.json`; inspect or change them with `node garda-agent-orchestrator/bin/garda.js review-capabilities list|enable|disable ... --target-root "."`.',
        '- Scope budget, review-cycle guard, task-reset availability, and project-memory maintenance are workflow settings. Change them only through `node garda-agent-orchestrator/bin/garda.js workflow set ... --target-root "."`.',
        '- Ordinary document path exceptions live in `garda-agent-orchestrator/live/config/paths.json` as `ordinary_doc_paths`; they are auditable planning/changelog doc exceptions, not a global ignore list.', '',
        '## Full-Suite Validation',
        fullSuiteLine,
        '- Full-suite out-of-scope handling is configured in `workflow-config.json`; do not change it to bypass a failing gate.', '',
        '## Indexing Note',
        '- Where the host supports indexing controls, exclude `garda-agent-orchestrator/` from application-code, stack-detection, and IDE/AI semantic indexing. Keep explicit Garda rule/config/skill paths and `bin/garda.js` readable to agents.',
        '- Do not infer the project stack or commands from the orchestrator bundle; inspect the host repository outside `garda-agent-orchestrator/` for application evidence.', '',
        '## Scope Safety',
        '- If the workspace is already dirty before task-mode entry, do not continue as a normal run; isolate the task scope with `--use-staged` or repeated `--changed-file` values before preflight.',
        '- Keep generated runtime artifacts out of task scope unless the task explicitly owns them.', '',
        '## Update Workspace',
        `- Interactive update: \`${getNodeInteractiveUpdateCommand()}\``,
        `- Non-interactive apply: \`${getNodeNonInteractiveUpdateCommand()}\``,
        `- Project memory init/refresh prompt after setup/update: ${PROJECT_MEMORY_REFRESH_HANDOFF_PROMPT}`, '',
        `Canonical instructions entrypoint for orchestration: \`${canonicalEntrypoint}\`.`,
        `Hard stop: first open \`${canonicalEntrypoint}\` and follow its routing links. Only then execute any task from \`TASK.md\`.`,
        'Orchestrator mode starts when task execution is requested from this file (`TASK.md`).',
        'If needed, the agent can add new tasks from user requests and then execute them in orchestrator mode.',
        commitGuardLine, '',
        'Tasks are managed in root `TASK.md`.',
        'This file can be replaced by the setup agent with project-specific instructions.'
    ];
}

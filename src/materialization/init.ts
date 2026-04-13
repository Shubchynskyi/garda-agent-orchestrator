import * as fs from 'node:fs';
import * as path from 'node:path';
import { ensureDirectory, pathExists, readTextFile } from '../core/fs';
import { readJsonFile } from '../core/json';
import { ALL_AGENT_ENTRYPOINT_FILES , resolveBundleName} from '../core/constants';
import { writeProtectedControlPlaneManifest } from '../gates/helpers';
import { syncReviewCapabilities, writeSkillsIndex } from '../runtime/skills';
import {
    getCanonicalEntrypointFile,
    getGitHubSkillBridgeProfileDefinitions,
    getProviderOrchestratorProfileDefinitions,
    SHARED_START_TASK_WORKFLOW_RELATIVE_PATH
} from './common';
import { getProjectDiscovery, buildProjectDiscoveryLines, buildDiscoveryOverlaySection } from './project-discovery';
import {
    RULE_FILES,
    GENERATED_RULE_FILES,
    selectRuleSource,
    applyContextDefaults,
    applyAssistantDefaults,
    generateProjectMemorySummary
} from './rule-materialization';
import { getNodeHumanCommitCommand, getNodeInteractiveUpdateCommand, getNodeNonInteractiveUpdateCommand } from './command-constants';
import { migrateContextRulesToProjectMemory, buildMigrationReportLines } from './project-memory-migration';
import { withLifecycleOperationLock } from '../lifecycle/common';

interface RunInitOptions {
    targetRoot: string;
    bundleRoot: string;
    dryRun?: boolean;
    assistantLanguage?: string;
    assistantBrevity?: string;
    sourceOfTruth?: string;
    enforceNoAutoCommit?: boolean;
    tokenEconomyEnabled?: boolean;
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
}

interface BuildUsageOptions {
    lang: string;
    brevity: string;
    canonicalEntrypoint: string;
    enforceNoAutoCommit: boolean;
}

function cloneJsonValue<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Runs the init materialization pipeline.
 * Node implementation of live materialization.
 *
 * @param {object} options
 * @param {string} options.targetRoot - Project root
 * @param {string} options.bundleRoot - Orchestrator bundle dir
 * @param {boolean} [options.dryRun=false]
 * @param {string} [options.assistantLanguage='English']
 * @param {string} [options.assistantBrevity='concise']
 * @param {string} [options.sourceOfTruth='Claude']
 * @param {boolean} [options.enforceNoAutoCommit=false]
 * @param {boolean} [options.tokenEconomyEnabled=true]
 * @returns {object} Init result metrics
 */
export function runInit(options: RunInitOptions) {
    const {
        targetRoot,
        bundleRoot,
        dryRun = false,
        assistantLanguage = 'English',
        assistantBrevity = 'concise',
        sourceOfTruth = 'Claude',
        enforceNoAutoCommit = false,
        tokenEconomyEnabled = true
    } = options;

    const templateRoot = path.join(bundleRoot, 'template');
    const liveRoot = path.join(bundleRoot, 'live');
    const templateRuleRoot = path.join(templateRoot, 'docs/agent-rules');
    const liveRuleRoot = path.join(liveRoot, 'docs/agent-rules');

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

    return withLifecycleOperationLock(normalizedTarget, 'init', () => {
    const projectName = path.basename(normalizedTarget);
    const timestampIso = new Date().toISOString();

    // Normalize parameters
    const lang = (assistantLanguage || 'English').trim() || 'English';
    let brevity = (assistantBrevity || 'concise').trim().toLowerCase();
    if (!['concise', 'detailed'].includes(brevity)) {
        throw new Error(`Unsupported AssistantBrevity value '${brevity}'. Allowed values: concise, detailed.`);
    }
    const trimmedSoT = (sourceOfTruth || 'Claude').trim();
    const canonicalEntrypoint = getCanonicalEntrypointFile(trimmedSoT);

    // Ensure live directories
    if (!dryRun) {
        ensureDirectory(liveRoot);
        ensureDirectory(liveRuleRoot);
    }

    // Project discovery
    const discovery = getProjectDiscovery(targetRoot);
    const discoveryLines = buildProjectDiscoveryLines(discovery, timestampIso);
    const discoveryOverlay = buildDiscoveryOverlaySection(discovery);

    // Seed project-memory from template only when absent (preserve user content on reinit/update)
    const seedOnlyDirectories = ['docs/project-memory'];
    let seededDirs = 0;

    for (const relDir of seedOnlyDirectories) {
        const srcDir = path.join(templateRoot, relDir);
        if (!pathExists(srcDir)) continue;

        const destDir = path.join(liveRoot, relDir);
        if (pathExists(destDir)) continue;

        if (!dryRun) {
            ensureDirectory(destDir);
            copyDirectoryRecursive(srcDir, destDir);
        }
        seededDirs++;
    }

    // T-075: migrate user-authored content from context rules into project-memory
    // (runs BEFORE rule materialization so current live/legacy content is still readable)
    const migrationResult = migrateContextRulesToProjectMemory({
        bundleRoot, targetRoot, templateRoot, dryRun
    });

    // Materialize rule files
    const ruleSourceMap: RuleSourceMapEntry[] = [];
    for (const ruleFile of RULE_FILES) {
        if (GENERATED_RULE_FILES.includes(ruleFile)) continue;

        const source = selectRuleSource(ruleFile, { targetRoot, liveRuleRoot, templateRuleRoot });
        if (!source) {
            throw new Error(`No source found for rule file: ${ruleFile}`);
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
            copyDirectoryRecursive(srcDir, destDir);
        }
        copiedSupportDirs++;
    }

    // Generate project-memory summary rule (always regenerated, after migration)
    const projectMemoryDir = path.join(liveRoot, 'docs/project-memory');
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

    // Handle managed config materialization (token-economy enabled flag)
    const managedConfigNames = ['review-capabilities', 'paths', 'token-economy', 'output-filters', 'skill-packs', 'isolation-mode', 'profiles', 'review-artifact-storage', 'garda.config'];
    const configMergeStatuses: Record<string, string> = {};

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
            const hadExistingConfig = pathExists(destConfigPath);

            if (hadExistingConfig) {
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
                : mergeConfig(templateConfig, existingConfig);

            // Apply token economy enabled flag
            if (configName === 'token-economy') {
                materializedConfig.enabled = tokenEconomyEnabled;
            }

            if (!dryRun) {
                const json = JSON.stringify(materializedConfig, null, 2);
                ensureDirectory(path.dirname(destConfigPath));
                fs.writeFileSync(destConfigPath, json, 'utf8');
            }

            configMergeStatuses[configName] = replaceWithCanonicalTemplate
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
    const sourceInventory = collectSourceInventory(targetRoot);
    const reviewCapabilitiesSync = dryRun ? null : syncReviewCapabilities(bundleRoot);

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
            reviewCapabilitiesSync
        });
        initReportLines.push(...buildMigrationReportLines(migrationResult));
        fs.writeFileSync(initReportPath, initReportLines.join('\r\n'), 'utf8');

        // Project discovery
        fs.writeFileSync(projectDiscoveryPath, discoveryLines.join('\r\n'), 'utf8');

        // Usage (seed if not present)
        if (!pathExists(usagePath)) {
            const usageLines = buildUsageLines({
                lang, brevity, canonicalEntrypoint, enforceNoAutoCommit
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
        tokenEconomyEnabled,
        ruleFilesMaterialized: RULE_FILES.length,
        supportDirectoriesSynced: copiedSupportDirs,
        seedOnlyDirectoriesSeeded: seededDirs,
        projectMemoryMigration: migrationResult,
        reviewCapabilitiesConfigMergeStatus: configMergeStatuses['review-capabilities'] || 'n/a',
        pathsConfigMergeStatus: configMergeStatuses['paths'] || 'n/a',
        tokenEconomyConfigMergeStatus: configMergeStatuses['token-economy'] || 'n/a',
        outputFiltersConfigMergeStatus: configMergeStatuses['output-filters'] || 'n/a',
        skillPacksConfigMergeStatus: configMergeStatuses['skill-packs'] || 'n/a',
        isolationModeConfigMergeStatus: configMergeStatuses['isolation-mode'] || 'n/a',
        profilesConfigMergeStatus: configMergeStatuses['profiles'] || 'n/a',
        reviewArtifactStorageConfigMergeStatus: configMergeStatuses['review-artifact-storage'] || 'n/a',
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

/**
 * Simple recursive config merge: template keys are baseline, existing values take precedence.
 */
export function mergeConfig(template: Record<string, unknown>, existing: Record<string, unknown> | null): Record<string, unknown> {
    if (!isPlainObject(existing)) {
        return cloneJsonValue(template);
    }

    if (Array.isArray(template)) {
        return Array.isArray(existing) ? cloneJsonValue(existing) as unknown as Record<string, unknown> : cloneJsonValue(template);
    }

    const result: Record<string, unknown> = {};
    // Copy all template keys, using existing values where present
    for (const key of Object.keys(template)) {
        const existingKey = Object.keys(existing).find((k) => k.toLowerCase() === key.toLowerCase());
        if (existingKey !== undefined && existing[existingKey] !== undefined) {
            if (isPlainObject(template[key]) && isPlainObject(existing[existingKey])) {
                result[key] = mergeConfig(template[key] as Record<string, unknown>, existing[existingKey] as Record<string, unknown>);
            } else {
                result[key] = cloneJsonValue(existing[existingKey]);
            }
        } else {
            result[key] = cloneJsonValue(template[key]);
        }
    }

    // Preserve unknown keys from existing
    for (const key of Object.keys(existing)) {
        if (!Object.keys(result).find((k) => k.toLowerCase() === key.toLowerCase())) {
            result[key] = cloneJsonValue(existing[key]);
        }
    }

    return result;
}

function copyDirectoryRecursive(srcDir: string, destDir: string): void {
    ensureDirectory(destDir);
    const entries = fs.readdirSync(srcDir, { withFileTypes: true });
    for (const entry of entries) {
        const srcPath = path.join(srcDir, entry.name);
        const destPath = path.join(destDir, entry.name);
        if (entry.isDirectory()) {
            copyDirectoryRecursive(srcPath, destPath);
        } else {
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
        '.antigravity/rules.md',
        '.junie/guidelines.md',
        '.windsurf/rules/rules.md'
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
        sourceInventory, reviewCapabilitiesSync } = opts;
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
        '- Isolation mode config sync policy: preserve existing live values, fill missing keys from template.',
        `- Isolation mode config merge status: ${configMergeStatuses['isolation-mode'] || 'n/a'}`,
        '- Profiles config sync policy: preserve existing live values and user profiles, fill missing keys from template.',
        `- Profiles config merge status: ${configMergeStatuses['profiles'] || 'n/a'}`,
        '- Review artifact storage config sync policy: preserve existing live values, fill missing keys from template.',
        `- Review artifact storage config merge status: ${configMergeStatuses['review-artifact-storage'] || 'n/a'}`,
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

    return lines;
}

function buildUsageLines(opts: BuildUsageOptions): string[] {
    const { lang, brevity, canonicalEntrypoint, enforceNoAutoCommit } = opts;
    const commitGuardLine = enforceNoAutoCommit
        ? `Hard no-auto-commit guard is enabled. It blocks detected agent-session commits while normal human commits remain available; for intentional manual commits from the same agent shell use: \`${getNodeHumanCommitCommand()}\`.`
        : 'Hard no-auto-commit guard is disabled.';

    return [
        '# Usage Instructions', '',
        `Language: ${lang}`,
        `Default response brevity: ${brevity}`, '',
        '## Execute Tasks',
        'Start by selecting a row from root `TASK.md` and tell the agent:',
        '- `Execute task <task-id> from TASK.md strictly through all mandatory orchestrator gates.`',
        '- The first execution reply must explicitly confirm `files not modified yet` before any edits and list the first gates it will run.',
        '- The command automatically runs mandatory orchestration gates in order: `enter-task-mode`, `load-rule-pack`, `handshake-diagnostics`, `shell-smoke-preflight`, `classify-change`, `load-rule-pack`, `compile-gate`, `build-review-context` (for each required review), `required-reviews-check`, `doc-impact-gate`, `completion-gate`.',
        '- Default execution comes from the active profile. Built-in profiles: `balanced` (depth `2`), `fast` (depth `1`), `strict` (depth `3`), `docs-only` (depth `1`).',
        '- Per-task profile override in `TASK.md` `Profile` column: `default` inherits the workspace active profile; explicit profile names override it.', '',
        '## Explicit Depth Override',
        '- Use `depth=<1|2|3>` only when you intentionally want a one-run override of the selected profile.',
        '- `depth=1`: force a shallow one-run execution.',
        '- `depth=2`: force a balanced one-run execution.',
        '- `depth=3`: force a strict one-run execution.',
        '- If the workspace is already dirty before task-mode entry, do not continue as a normal run; isolate the task scope with `--use-staged` or repeated `--changed-file` values before preflight.',
        '- If token economy mode is enabled, use `depth=1` only for small, well-localized tasks; default `depth=3` keeps full reviewer context while shared gate-output compaction still applies.', '',
        '## Update Workspace',
        `- Interactive update: \`${getNodeInteractiveUpdateCommand()}\``,
        `- Non-interactive apply: \`${getNodeNonInteractiveUpdateCommand()}\``, '',
        `Canonical instructions entrypoint for orchestration: \`${canonicalEntrypoint}\`.`,
        `Hard stop: first open \`${canonicalEntrypoint}\` and follow its routing links. Only then execute any task from \`TASK.md\`.`,
        'Orchestrator mode starts when task execution is requested from this file (`TASK.md`).',
        'If needed, the agent can add new tasks from user requests and then execute them in orchestrator mode.',
        commitGuardLine, '',
        'Tasks are managed in root `TASK.md`.',
        'This file can be replaced by the setup agent with project-specific instructions.'
    ];
}

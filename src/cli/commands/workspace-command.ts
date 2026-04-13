import * as fs from 'node:fs';
import * as path from 'node:path';
import { SOURCE_OF_TRUTH_VALUES } from '../../core/constants';
import { withLifecycleOperationLockAsync } from '../../lifecycle/common';
import { runCleanupWithLock, runGcWithLock, validateGcCategories } from '../../lifecycle/cleanup';
import { runUninstall } from '../../lifecycle/uninstall';
import { runReinit } from '../../materialization/reinit';
import { runInit } from '../../materialization/init';
import { runInstall } from '../../materialization/install';
import { runVerify, formatVerifyResult, formatVerifyResultCompact } from '../../validators/verify';
import {
    acquireSourceRoot,
    cyan,
    dim,
    ensureDirectoryExists,
    getBundlePath,
    getInitAnswerValue,
    green,
    normalizeActiveAgentFiles,
    normalizeAssistantBrevity,
    normalizePathValue,
    normalizeSourceOfTruth,
    PackageJsonLike,
    parseOptions,
    printBanner,
    printHelp,
    printHighlightedPair,
    promptSingleSelect,
    promptTextInput,
    readInitAnswersArtifact,
    readOptionalJsonFile,
    resolveWorkspaceDisplayVersion,
    supportsInteractivePrompts,
    syncBundleItems,
    tryNormalizeAssistantBrevity,
    tryNormalizeSourceOfTruth,
    tryParseBooleanText,
    yellow
} from './cli-helpers';
import { handleCleanupPolicyCommand } from './cleanup-policy';
import {
    countStoragePolicyActions,
    ensureBundleExists,
    formatKeyValueOutput,
    getDefaultInitAnswersPath,
    normalizeYesNo,
    ParsedOptionsRecord,
    ValidationFailureError
} from './shared-command-utils';

export async function handleInstall(commandArgv: string[], packageJson: PackageJsonLike, packageRoot: string): Promise<void> {
    const installDefinitions = {
        '--target-root': { key: 'targetRoot', type: 'string' },
        '--init-answers-path': { key: 'initAnswersPath', type: 'string' },
        '--repo-url': { key: 'repoUrl', type: 'string' },
        '--branch': { key: 'branch', type: 'string' },
        '--dry-run': { key: 'dryRun', type: 'boolean' }
    };
    const { options: rawOptions } = parseOptions(commandArgv, installDefinitions);
    const options = rawOptions as ParsedOptionsRecord;

    if (options.help) {
        printHelp(packageJson);
        return;
    }
    if (options.version) {
        console.log(packageJson.version);
        return;
    }

    const targetRoot = normalizePathValue(options.targetRoot || '.');
    ensureDirectoryExists(targetRoot, 'Target root');

    const source = await acquireSourceRoot(
        typeof options.repoUrl === 'string' ? options.repoUrl : undefined,
        typeof options.branch === 'string' ? options.branch : undefined,
        packageRoot
    );
    try {
        await withLifecycleOperationLockAsync(targetRoot, 'install', async () => {
        const bundlePath = getBundlePath(targetRoot);
        const sourceResolved = path.resolve(source.sourceRoot);
        const bundleResolved = path.resolve(bundlePath);
        if (sourceResolved.toLowerCase() !== bundleResolved.toLowerCase() && !options.dryRun) {
            syncBundleItems(source.sourceRoot, bundlePath);
        }

        const effectiveBundlePath = fs.existsSync(bundlePath) ? bundlePath : source.sourceRoot;
        const initAnswersPath = typeof options.initAnswersPath === 'string'
            ? options.initAnswersPath
            : getDefaultInitAnswersPath(targetRoot, bundlePath);
        const answers = readInitAnswersArtifact(targetRoot, initAnswersPath, getBundlePath(targetRoot), 'install');
        const installResult = runInstall({
            targetRoot,
            bundleRoot: effectiveBundlePath,
            assistantLanguage: answers.assistantLanguage,
            assistantBrevity: answers.assistantBrevity,
            sourceOfTruth: answers.sourceOfTruth,
            initAnswersPath: answers.resolvedPath,
            dryRun: options.dryRun === true,
            initRunner(initOptions) {
                runInit({ bundleRoot: effectiveBundlePath, ...initOptions });
            }
        }) as Record<string, unknown>;
        formatKeyValueOutput(installResult, [
            'targetRoot', 'sourceOfTruth', 'canonicalEntrypoint',
            'assistantLanguage', 'assistantBrevity',
            'filesDeployed', 'initInvoked', 'liveVersionWritten',
            'dryRun'
        ]);
        });
    } finally {
        source.cleanup();
    }
}

export function handleInit(commandArgv: string[], packageJson: PackageJsonLike): void {
    const initDefinitions = {
        '--target-root': { key: 'targetRoot', type: 'string' },
        '--init-answers-path': { key: 'initAnswersPath', type: 'string' },
        '--dry-run': { key: 'dryRun', type: 'boolean' }
    };
    const { options: rawOptions } = parseOptions(commandArgv, initDefinitions);
    const options = rawOptions as ParsedOptionsRecord;

    if (options.help) {
        printHelp(packageJson);
        return;
    }
    if (options.version) {
        console.log(packageJson.version);
        return;
    }

    const targetRoot = normalizePathValue(options.targetRoot || '.');
    ensureDirectoryExists(targetRoot, 'Target root');
    const bundlePath = ensureBundleExists(targetRoot, 'init');
    const initAnswersPath = typeof options.initAnswersPath === 'string'
        ? options.initAnswersPath
        : getDefaultInitAnswersPath(targetRoot, bundlePath);
    const answers = readInitAnswersArtifact(targetRoot, initAnswersPath, bundlePath, 'init');

    const initResult = runInit({
        targetRoot,
        bundleRoot: bundlePath,
        assistantLanguage: answers.assistantLanguage,
        assistantBrevity: answers.assistantBrevity,
        sourceOfTruth: answers.sourceOfTruth,
        enforceNoAutoCommit: answers.enforceNoAutoCommit,
        tokenEconomyEnabled: answers.tokenEconomyEnabled,
        dryRun: options.dryRun === true
    }) as Record<string, unknown>;
    console.log('Init: PASS');
    formatKeyValueOutput(initResult, [
        'targetRoot', 'sourceOfTruth', 'assistantLanguage',
        'ruleFilesMaterialized', 'projectDiscoveryPath', 'usagePath'
    ]);
}

export async function handleReinit(commandArgv: string[], packageJson: PackageJsonLike): Promise<void> {
    const reinitDefinitions = {
        '--target-root': { key: 'targetRoot', type: 'string' },
        '--init-answers-path': { key: 'initAnswersPath', type: 'string' },
        '--no-prompt': { key: 'noPrompt', type: 'boolean' },
        '--skip-verify': { key: 'skipVerify', type: 'boolean' },
        '--skip-manifest-validation': { key: 'skipManifestValidation', type: 'boolean' },
        '--assistant-language': { key: 'assistantLanguage', type: 'string' },
        '--assistant-brevity': { key: 'assistantBrevity', type: 'string' },
        '--source-of-truth': { key: 'sourceOfTruth', type: 'string' },
        '--enforce-no-auto-commit': { key: 'enforceNoAutoCommit', type: 'string' },
        '--claude-orchestrator-full-access': { key: 'claudeOrchestratorFullAccess', type: 'string' },
        '--claude-full-access': { key: 'claudeOrchestratorFullAccess', type: 'string' },
        '--token-economy-enabled': { key: 'tokenEconomyEnabled', type: 'string' },
        '--provider-minimalism': { key: 'providerMinimalism', type: 'string' }
    };
    const { options: rawOptions } = parseOptions(commandArgv, reinitDefinitions);
    const options = rawOptions as ParsedOptionsRecord;

    if (options.help) {
        printHelp(packageJson);
        return;
    }
    if (options.version) {
        console.log(packageJson.version);
        return;
    }

    const targetRoot = normalizePathValue(options.targetRoot || '.');
    ensureDirectoryExists(targetRoot, 'Target root');
    const bundlePath = ensureBundleExists(targetRoot, 'reinit');

    const initAnswersPath = typeof options.initAnswersPath === 'string'
        ? options.initAnswersPath
        : getDefaultInitAnswersPath(targetRoot, bundlePath);
    const resolvedInitAnswersPath = path.resolve(targetRoot, initAnswersPath);
    const existingAnswers = readOptionalJsonFile(resolvedInitAnswersPath) || {};

    const interactiveReinit = !options.noPrompt;
    const canUseInteractivePrompts = interactiveReinit && supportsInteractivePrompts();

    let assistantLanguage = (options.assistantLanguage !== undefined ? String(options.assistantLanguage) : null) || getInitAnswerValue(existingAnswers, 'AssistantLanguage') || 'English';
    let assistantBrevity = tryNormalizeAssistantBrevity(options.assistantBrevity ?? getInitAnswerValue(existingAnswers, 'AssistantBrevity'), 'concise');
    let sourceOfTruth = tryNormalizeSourceOfTruth(options.sourceOfTruth ?? getInitAnswerValue(existingAnswers, 'SourceOfTruth'), 'Claude');
    let activeAgentFiles = getInitAnswerValue(existingAnswers, 'ActiveAgentFiles') || '';
    let enforceNoAutoCommit = tryParseBooleanText(options.enforceNoAutoCommit ?? getInitAnswerValue(existingAnswers, 'EnforceNoAutoCommit'), true);
    let claudeOrchestratorFullAccess = tryParseBooleanText(options.claudeOrchestratorFullAccess ?? getInitAnswerValue(existingAnswers, 'ClaudeOrchestratorFullAccess'), false);
    let tokenEconomyEnabled = tryParseBooleanText(options.tokenEconomyEnabled ?? getInitAnswerValue(existingAnswers, 'TokenEconomyEnabled'), true);
    let providerMinimalism = tryParseBooleanText(options.providerMinimalism ?? getInitAnswerValue(existingAnswers, 'ProviderMinimalism'), true);

    if (canUseInteractivePrompts) {
        assistantLanguage = await promptTextInput('Set communication language', String(assistantLanguage));
        assistantBrevity = await promptSingleSelect({
            title: 'Set default response brevity',
            defaultLabel: String(assistantBrevity),
            defaultValue: String(assistantBrevity),
            options: [
                { label: 'concise', value: 'concise' },
                { label: 'detailed', value: 'detailed' }
            ]
        });
        sourceOfTruth = await promptSingleSelect({
            title: 'Set primary source-of-truth entrypoint',
            defaultLabel: String(sourceOfTruth),
            defaultValue: String(sourceOfTruth),
            options: [...SOURCE_OF_TRUTH_VALUES].map((v) => ({ label: v, value: v }))
        });
        enforceNoAutoCommit = await promptSingleSelect({
            title: 'Set no-auto-commit guard mode',
            defaultLabel: enforceNoAutoCommit ? 'Yes' : 'No',
            defaultValue: enforceNoAutoCommit ? 'true' : 'false',
            options: [
                { label: 'No', value: 'false' },
                { label: 'Yes', value: 'true' }
            ]
        }) === 'true';
        claudeOrchestratorFullAccess = await promptSingleSelect({
            title: 'Set Claude access level for orchestrator files',
            defaultLabel: claudeOrchestratorFullAccess ? 'Yes' : 'No',
            defaultValue: claudeOrchestratorFullAccess ? 'true' : 'false',
            options: [
                { label: 'No', value: 'false' },
                { label: 'Yes', value: 'true' }
            ]
        }) === 'true';
        tokenEconomyEnabled = await promptSingleSelect({
            title: 'Set default token economy mode',
            defaultLabel: tokenEconomyEnabled ? 'Yes' : 'No',
            defaultValue: tokenEconomyEnabled ? 'true' : 'false',
            options: [
                { label: 'No', value: 'false' },
                { label: 'Yes', value: 'true' }
            ]
        }) === 'true';
        providerMinimalism = await promptSingleSelect({
            title: 'Set provider entrypoint minimalism mode',
            defaultLabel: providerMinimalism ? 'Yes' : 'No',
            defaultValue: providerMinimalism ? 'true' : 'false',
            options: [
                { label: 'Yes', value: 'true' },
                { label: 'No', value: 'false' }
            ]
        }) === 'true';
    }

    const overrides: Record<string, string> = {
        AssistantLanguage: String(assistantLanguage),
        AssistantBrevity: normalizeAssistantBrevity(assistantBrevity),
        SourceOfTruth: normalizeSourceOfTruth(sourceOfTruth),
        ActiveAgentFiles: normalizeActiveAgentFiles(activeAgentFiles, sourceOfTruth) || '',
        EnforceNoAutoCommit: String(enforceNoAutoCommit),
        ClaudeOrchestratorFullAccess: String(claudeOrchestratorFullAccess),
        TokenEconomyEnabled: String(tokenEconomyEnabled),
        ProviderMinimalism: String(providerMinimalism)
    };

    const reinitResult = runReinit({
        targetRoot,
        bundleRoot: bundlePath,
        initAnswersPath,
        overrides,
        skipVerify: options.skipVerify === true,
        skipManifestValidation: options.skipManifestValidation === true
    }) as Record<string, unknown>;
    console.log('Reinit: PASS');
    formatKeyValueOutput(reinitResult, [
        'targetRoot',
        'initAnswersPath',
        'assistantLanguage',
        'assistantBrevity',
        'sourceOfTruth',
        'enforceNoAutoCommit',
        'claudeOrchestratorFullAccess',
        'tokenEconomyEnabled',
        'providerMinimalism',
        'coreRuleUpdated',
        'tokenEconomyConfigUpdated',
        'verifyStatus',
        'manifestValidationStatus'
    ]);
}

export function handleUninstall(commandArgv: string[], packageJson: PackageJsonLike): void {
    const uninstallDefinitions = {
        '--target-root': { key: 'targetRoot', type: 'string' },
        '--init-answers-path': { key: 'initAnswersPath', type: 'string' },
        '--no-prompt': { key: 'noPrompt', type: 'boolean' },
        '--dry-run': { key: 'dryRun', type: 'boolean' },
        '--skip-backups': { key: 'skipBackups', type: 'boolean' },
        '--keep-primary-entrypoint': { key: 'keepPrimaryEntrypoint', type: 'string' },
        '--keep-task-file': { key: 'keepTaskFile', type: 'string' },
        '--keep-runtime-artifacts': { key: 'keepRuntimeArtifacts', type: 'string' },
        '--json': { key: 'json', type: 'boolean' }
    };
    const { options: rawOptions } = parseOptions(commandArgv, uninstallDefinitions);
    const options = rawOptions as ParsedOptionsRecord;

    if (options.help) {
        printHelp(packageJson);
        return;
    }
    if (options.version) {
        console.log(packageJson.version);
        return;
    }

    const targetRoot = normalizePathValue(options.targetRoot || '.');
    ensureDirectoryExists(targetRoot, 'Target root');
    const bundlePath = ensureBundleExists(targetRoot, 'uninstall');
    const uninstallResult = runUninstall({
        targetRoot,
        bundleRoot: bundlePath,
        initAnswersPath: typeof options.initAnswersPath === 'string'
            ? options.initAnswersPath
            : getDefaultInitAnswersPath(targetRoot, bundlePath),
        noPrompt: options.noPrompt === true,
        dryRun: options.dryRun === true,
        skipBackups: options.skipBackups === true,
        keepPrimaryEntrypoint: options.keepPrimaryEntrypoint !== undefined
            ? normalizeYesNo(options.keepPrimaryEntrypoint, 'KeepPrimaryEntrypoint')
            : undefined,
        keepTaskFile: options.keepTaskFile !== undefined
            ? normalizeYesNo(options.keepTaskFile, 'KeepTaskFile')
            : undefined,
        keepRuntimeArtifacts: options.keepRuntimeArtifacts !== undefined
            ? normalizeYesNo(options.keepRuntimeArtifacts, 'KeepRuntimeArtifacts')
            : undefined
    });

    if (options.json === true) {
        console.log(JSON.stringify(uninstallResult, null, 2));
        return;
    }

    formatKeyValueOutput(uninstallResult as unknown as Record<string, unknown>, [
        'targetRoot', 'keepPrimaryEntrypoint', 'keepTaskFile',
        'keepRuntimeArtifacts', 'dryRun', 'backupRoot',
        'preservedRuntimePath', 'filesDeleted', 'directoriesDeleted',
        'filesRestored', 'itemsBackedUp', 'rollbackStatus',
        'warningsCount'
    ]);
    console.log(`Result: ${uninstallResult.result || 'SUCCESS'}`);
    console.log(green('Uninstall complete.'));
    if (uninstallResult.filesRestored > 0) {
        printHighlightedPair('Restored user files:', String(uninstallResult.filesRestored), {
            labelColor: cyan,
            valueColor: green
        });
    }
    if (uninstallResult.backupRoot && uninstallResult.backupRoot !== '<none>' && uninstallResult.itemsBackedUp > 0) {
        console.log(yellow('Backup files were created.'));
        printHighlightedPair('Backup path:', uninstallResult.backupRoot, {
            labelColor: yellow,
            valueColor: cyan
        });
        printHighlightedPair('Backed up items:', String(uninstallResult.itemsBackedUp), {
            labelColor: yellow,
            valueColor: green
        });
        if (uninstallResult.preservedRuntimePath && uninstallResult.preservedRuntimePath !== '<none>') {
            printHighlightedPair('Preserved runtime:', uninstallResult.preservedRuntimePath, {
                labelColor: yellow,
                valueColor: cyan
            });
        }
    } else {
        console.log(dim('No backup files were created during uninstall.'));
    }
    if (Array.isArray(uninstallResult.warnings) && uninstallResult.warnings.length > 0) {
        console.log(yellow('Warnings:'));
        for (const warning of uninstallResult.warnings) {
            console.log(`  - ${warning}`);
        }
    }
}

export function handleCleanup(commandArgv: string[], packageJson: PackageJsonLike): Promise<void> | void {
    const firstArg = String(commandArgv[0] || '').trim();
    if (firstArg === 'policy') {
        const policyArgv = commandArgv.slice(1);
        const policyFirstArg = String(policyArgv[0] || '').trim();
        const hasExplicitSubcommand = policyFirstArg.length > 0 && !policyFirstArg.startsWith('-');
        const policySubcommand = hasExplicitSubcommand ? policyFirstArg : 'show';
        const policyCommandArgv = hasExplicitSubcommand ? policyArgv.slice(1) : policyArgv;

        const cleanupPolicyDefinitions = {
            '--target-root': { key: 'targetRoot', type: 'string' },
            '--json': { key: 'json', type: 'boolean' },
            '--edit': { key: 'edit', type: 'boolean' },
            '--reset': { key: 'reset', type: 'boolean' },
            '--retention-mode': { key: 'retentionMode', type: 'string' },
            '--compress-after-days': { key: 'compressAfterDays', type: 'string' },
            '--compression-format': { key: 'compressionFormat', type: 'string' },
            '--preserve-gate-receipts': { key: 'preserveGateReceipts', type: 'string' },
            '--gate-receipt-suffix': { key: 'gateReceiptSuffixes', type: 'string[]' }
        };
        const { options: rawPolicyOptions } = parseOptions(policyCommandArgv, cleanupPolicyDefinitions);
        const policyOptions = rawPolicyOptions as ParsedOptionsRecord;

        if (policyOptions.help) {
            printHelp(packageJson);
            return;
        }
        if (policyOptions.version) {
            console.log(packageJson.version);
            return;
        }

        if (!['show', 'edit', 'reset'].includes(policySubcommand)) {
            throw new Error(`Unknown cleanup policy action: ${policySubcommand}. Allowed values: show, edit, reset.`);
        }

        const targetRoot = normalizePathValue(policyOptions.targetRoot || '.');
        ensureDirectoryExists(targetRoot, 'Target root');
        const bundlePath = ensureBundleExists(targetRoot, 'cleanup policy');

        return handleCleanupPolicyCommand(bundlePath, {
            retentionMode: typeof policyOptions.retentionMode === 'string' ? policyOptions.retentionMode : undefined,
            compressAfterDays: typeof policyOptions.compressAfterDays === 'string' ? policyOptions.compressAfterDays : undefined,
            compressionFormat: typeof policyOptions.compressionFormat === 'string' ? policyOptions.compressionFormat : undefined,
            preserveGateReceipts: typeof policyOptions.preserveGateReceipts === 'string' ? policyOptions.preserveGateReceipts : undefined,
            gateReceiptSuffixes: Array.isArray(policyOptions.gateReceiptSuffixes) ? policyOptions.gateReceiptSuffixes as string[] : undefined,
            edit: policySubcommand === 'edit' || policyOptions.edit === true,
            reset: policySubcommand === 'reset' || policyOptions.reset === true,
            json: policyOptions.json === true
        });
    }

    const cleanupDefinitions = {
        '--target-root': { key: 'targetRoot', type: 'string' },
        '--dry-run': { key: 'dryRun', type: 'boolean' },
        '--max-age-days': { key: 'maxAgeDays', type: 'string' },
        '--max-backups': { key: 'maxBackups', type: 'string' },
        '--max-task-events': { key: 'maxTaskEvents', type: 'string' },
        '--max-aggregate-lines': { key: 'maxAggregateLines', type: 'string' },
        '--max-reviews': { key: 'maxReviews', type: 'string' },
        '--max-update-reports': { key: 'maxUpdateReports', type: 'string' },
        '--max-update-rollbacks': { key: 'maxUpdateRollbacks', type: 'string' },
        '--max-bundle-backups': { key: 'maxBundleBackups', type: 'string' }
    };
    const { options: rawOptions } = parseOptions(commandArgv, cleanupDefinitions);
    const options = rawOptions as ParsedOptionsRecord;

    if (options.help) {
        printHelp(packageJson);
        return;
    }
    if (options.version) {
        console.log(packageJson.version);
        return;
    }

    const targetRoot = normalizePathValue(options.targetRoot || '.');
    ensureDirectoryExists(targetRoot, 'Target root');
    printBanner(packageJson, 'Runtime cleanup', targetRoot, {
        versionOverride: resolveWorkspaceDisplayVersion(targetRoot, packageJson.version)
    });
    const bundlePath = ensureBundleExists(targetRoot, 'cleanup');
    const dryRun = options.dryRun === true;

    const retentionOverrides: Record<string, number> = {};
    const intFields: Array<[string, string]> = [
        ['maxAgeDays', 'maxAgeDays'],
        ['maxBackups', 'maxBackups'],
        ['maxTaskEvents', 'maxTaskEvents'],
        ['maxAggregateLines', 'maxAggregateLines'],
        ['maxReviews', 'maxReviews'],
        ['maxUpdateReports', 'maxUpdateReports'],
        ['maxUpdateRollbacks', 'maxUpdateRollbacks'],
        ['maxBundleBackups', 'maxBundleBackups']
    ];
    for (const [optKey, policyKey] of intFields) {
        const raw = options[optKey];
        if (typeof raw === 'string') {
            const parsed = parseInt(raw, 10);
            if (Number.isNaN(parsed) || parsed < 0) {
                throw new Error(`--${optKey.replace(/([A-Z])/g, '-$1').toLowerCase()} must be a non-negative integer, got: ${raw}`);
            }
            retentionOverrides[policyKey] = parsed;
        }
    }

    const cleanupResult = runCleanupWithLock({
        targetRoot,
        bundleRoot: bundlePath,
        dryRun,
        retentionPolicy: retentionOverrides
    });

    if (dryRun) {
        console.log(yellow('Dry run — no files were removed.'));
    }

    formatKeyValueOutput(cleanupResult as unknown as Record<string, unknown>, [
        'targetRoot', 'dryRun', 'totalFreedBytes', 'result'
    ]);

    const removedOrSkipped = dryRun ? cleanupResult.skipped : cleanupResult.removed;
    if (removedOrSkipped.length === 0) {
        console.log(green('Nothing to clean up.'));
        return;
    }

    // Group items by category for compact output
    const byCategory = new Map<string, number>();
    for (const item of removedOrSkipped) {
        byCategory.set(item.category, (byCategory.get(item.category) || 0) + 1);
    }
    const action = dryRun ? 'Would remove' : 'Removed';
    for (const [category, count] of byCategory) {
        printHighlightedPair(`${action} (${category}):`, String(count), {
            labelColor: cyan,
            valueColor: green
        });
    }

    const freedLabel = dryRun ? 'Would free' : 'Freed';
    const freedMB = (cleanupResult.totalFreedBytes / (1024 * 1024)).toFixed(2);
    printHighlightedPair(`${freedLabel}:`, `${freedMB} MB`, {
        labelColor: cyan,
        valueColor: green
    });

    if (cleanupResult.errors.length > 0) {
        console.log(yellow(`Errors: ${cleanupResult.errors.length}`));
        for (const err of cleanupResult.errors) {
            console.log(`  ${err.path}: ${err.message}`);
        }
    }

    console.log(`Result: ${cleanupResult.result}`);
    if (!dryRun) {
        console.log(green('Cleanup complete.'));
    }
}

export function handleGc(commandArgv: string[], packageJson: PackageJsonLike): void {
    const gcDefinitions = {
        '--target-root': { key: 'targetRoot', type: 'string' },
        '--confirm': { key: 'confirm', type: 'boolean' },
        '--dry-run': { key: 'dryRun', type: 'boolean' },
        '--category': { key: 'category', type: 'string[]' },
        '--max-age-days': { key: 'maxAgeDays', type: 'string' },
        '--max-backups': { key: 'maxBackups', type: 'string' },
        '--max-task-events': { key: 'maxTaskEvents', type: 'string' },
        '--max-aggregate-lines': { key: 'maxAggregateLines', type: 'string' },
        '--max-reviews': { key: 'maxReviews', type: 'string' },
        '--max-update-reports': { key: 'maxUpdateReports', type: 'string' },
        '--max-update-rollbacks': { key: 'maxUpdateRollbacks', type: 'string' },
        '--max-bundle-backups': { key: 'maxBundleBackups', type: 'string' }
    };
    const { options: rawOptions } = parseOptions(commandArgv, gcDefinitions);
    const options = rawOptions as ParsedOptionsRecord;

    if (options.help) {
        printHelp(packageJson);
        return;
    }
    if (options.version) {
        console.log(packageJson.version);
        return;
    }

    const targetRoot = normalizePathValue(options.targetRoot || '.');
    ensureDirectoryExists(targetRoot, 'Target root');
    printBanner(packageJson, 'Runtime gc', targetRoot, {
        versionOverride: resolveWorkspaceDisplayVersion(targetRoot, packageJson.version)
    });
    const bundlePath = ensureBundleExists(targetRoot, 'gc');

    // Dry-run by default; --confirm to actually delete. --dry-run explicitly
    // forces dry-run even if --confirm is also passed.
    const explicitDryRun = options.dryRun === true;
    const confirm = options.confirm === true && !explicitDryRun;

    const retentionOverrides: Record<string, number> = {};
    const intFields: Array<[string, string]> = [
        ['maxAgeDays', 'maxAgeDays'],
        ['maxBackups', 'maxBackups'],
        ['maxTaskEvents', 'maxTaskEvents'],
        ['maxAggregateLines', 'maxAggregateLines'],
        ['maxReviews', 'maxReviews'],
        ['maxUpdateReports', 'maxUpdateReports'],
        ['maxUpdateRollbacks', 'maxUpdateRollbacks'],
        ['maxBundleBackups', 'maxBundleBackups']
    ];
    for (const [optKey, policyKey] of intFields) {
        const raw = options[optKey];
        if (typeof raw === 'string') {
            const parsed = parseInt(raw, 10);
            if (Number.isNaN(parsed) || parsed < 0) {
                throw new Error(`--${optKey.replace(/([A-Z])/g, '-$1').toLowerCase()} must be a non-negative integer, got: ${raw}`);
            }
            retentionOverrides[policyKey] = parsed;
        }
    }

    // Category filter
    const categories: string[] = [];
    if (Array.isArray(options.category)) {
        for (const cat of options.category) {
            if (typeof cat === 'string') categories.push(cat);
        }
    } else if (typeof options.category === 'string') {
        categories.push(options.category);
    }

    if (categories.length > 0) {
        validateGcCategories(categories);
    }

    const gcResult = runGcWithLock({
        targetRoot,
        bundleRoot: bundlePath,
        confirm,
        retentionPolicy: retentionOverrides,
        categories: categories.length > 0 ? categories : undefined
    });

    if (!confirm) {
        console.log(yellow('Dry run (default) — no files were removed. Pass --confirm to delete.'));
    }

    formatKeyValueOutput(gcResult as unknown as Record<string, unknown>, [
        'targetRoot', 'dryRun', 'totalFreedBytes', 'staleLocksCleaned', 'result'
    ]);

    const actionItems = gcResult.dryRun ? gcResult.skipped : gcResult.removed;
    const storagePolicyActions = countStoragePolicyActions(gcResult.storagePolicyResult);
    if (actionItems.length === 0 && gcResult.staleLocksCleaned === 0 && storagePolicyActions === 0) {
        console.log(green('Nothing to clean up.'));
        return;
    }

    // Per-category summary
    for (const [category, summary] of Object.entries(gcResult.categories)) {
        const catMB = (summary.bytes / (1024 * 1024)).toFixed(2);
        const action = gcResult.dryRun ? 'Would remove' : 'Removed';
        printHighlightedPair(`${action} (${category}):`, `${summary.count} items (${catMB} MB)`, {
            labelColor: cyan,
            valueColor: green
        });
    }

    if (gcResult.staleLocksCleaned > 0) {
        const lockAction = gcResult.dryRun ? 'Would clean' : 'Cleaned';
        printHighlightedPair(`${lockAction} stale locks:`, String(gcResult.staleLocksCleaned), {
            labelColor: cyan,
            valueColor: green
        });
    }

    if (gcResult.storagePolicyResult) {
        const storageAction = gcResult.dryRun ? 'Would remove review artifacts:' : 'Removed review artifacts:';
        if (gcResult.storagePolicyResult.removed.length > 0) {
            printHighlightedPair(storageAction, String(gcResult.storagePolicyResult.removed.length), {
                labelColor: cyan,
                valueColor: green
            });
        }
        const compressionAction = gcResult.dryRun ? 'Would compress review artifacts:' : 'Compressed review artifacts:';
        if (gcResult.storagePolicyResult.compressed.length > 0) {
            printHighlightedPair(compressionAction, String(gcResult.storagePolicyResult.compressed.length), {
                labelColor: cyan,
                valueColor: green
            });
        }
    }

    const freedLabel = gcResult.dryRun ? 'Would free' : 'Freed';
    const freedMB = (gcResult.totalFreedBytes / (1024 * 1024)).toFixed(2);
    printHighlightedPair(`${freedLabel}:`, `${freedMB} MB`, {
        labelColor: cyan,
        valueColor: green
    });

    if (gcResult.errors.length > 0) {
        console.log(yellow(`Errors: ${gcResult.errors.length}`));
        for (const err of gcResult.errors) {
            console.log(`  ${err.path}: ${err.message}`);
        }
    }

    console.log(`Result: ${gcResult.result}`);
    if (confirm) {
        console.log(green('GC complete.'));
    }
}

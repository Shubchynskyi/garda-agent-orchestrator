import { assertExplicitCliTrustOverride } from '../../lifecycle/update-trust';
import { type CheckUpdateRunnerOptions, runCheckUpdate } from '../../lifecycle/check-update';
import { runUpdateFromGit } from '../../lifecycle/update-git';
import { runRollback } from '../../lifecycle/rollback';
import {
    ensureDirectoryExists,
    normalizePathValue,
    PackageJsonLike,
    parseOptions,
    printHelp
} from './cli-helpers';
import {
    buildUpdateLifecycleRunner,
    ensureBundleExists,
    formatKeyValueOutput,
    getDefaultInitAnswersPath,
    mergeUpdateLifecycleOutput,
    ParsedOptionsRecord,
    toKeyValueRecord,
    UpdateLifecycleResult
} from './shared-command-utils';

export async function handleUpdate(commandArgv: string[], packageJson: PackageJsonLike): Promise<void> {
    if (commandArgv.length > 0 && String(commandArgv[0] || '').trim().toLowerCase() === 'git') {
        await handleUpdateGit(commandArgv.slice(1), packageJson);
        return;
    }

    const updateDefinitions = {
        '--target-root': { key: 'targetRoot', type: 'string' },
        '--init-answers-path': { key: 'initAnswersPath', type: 'string' },
        '--package-spec': { key: 'packageSpec', type: 'string' },
        '--source-path': { key: 'sourcePath', type: 'string' },
        '--no-prompt': { key: 'noPrompt', type: 'boolean' },
        '--dry-run': { key: 'dryRun', type: 'boolean' },
        '--skip-verify': { key: 'skipVerify', type: 'boolean' },
        '--skip-manifest-validation': { key: 'skipManifestValidation', type: 'boolean' },
        '--trust-override': { key: 'trustOverride', type: 'boolean' },
        '--json': { key: 'json', type: 'boolean' }
    };
    const { options: rawOptions } = parseOptions(commandArgv, updateDefinitions);
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
    const bundlePath = ensureBundleExists(targetRoot, 'update');
    assertExplicitCliTrustOverride('update', {
        trustOverride: options.trustOverride === true,
        noPrompt: options.noPrompt === true
    });

    let lifecycleResult: UpdateLifecycleResult | null = null;
    const updateResult = await runCheckUpdate({
        targetRoot,
        bundleRoot: bundlePath,
        initAnswersPath: typeof options.initAnswersPath === 'string'
            ? options.initAnswersPath
            : getDefaultInitAnswersPath(targetRoot, bundlePath),
        packageSpec: typeof options.packageSpec === 'string' ? options.packageSpec : undefined,
        sourcePath: typeof options.sourcePath === 'string' ? options.sourcePath : undefined,
        apply: true,
        noPrompt: options.noPrompt === true,
        dryRun: options.dryRun === true,
        skipVerify: options.skipVerify === true,
        skipManifestValidation: options.skipManifestValidation === true,
        trustOverride: options.trustOverride === true,
        updateRunner(runnerOptions) {
            lifecycleResult = buildUpdateLifecycleRunner(bundlePath, options.dryRun === true)(runnerOptions);
        }
    });
    const mergedUpdateResult = mergeUpdateLifecycleOutput(toKeyValueRecord(updateResult), lifecycleResult);
    if (options.json === true) {
        console.log(JSON.stringify(mergedUpdateResult, null, 2));
    } else {
        formatKeyValueOutput(mergedUpdateResult, [
            'targetRoot', 'sourceType', 'sourceReference', 'packageSpec', 'sourcePath',
            'currentVersion', 'latestVersion', 'updateAvailable',
            'updateApplied', 'checkUpdateResult', 'trustPolicy', 'trustOverrideUsed', 'trustOverrideSource',
            'previousVersion', 'updatedVersion', 'rollbackSnapshotPath', 'rollbackStatus', 'updateReportPath'
        ]);
    }
}

export async function handleUpdateGit(commandArgv: string[], packageJson: PackageJsonLike): Promise<void> {
    const updateGitDefinitions = {
        '--target-root': { key: 'targetRoot', type: 'string' },
        '--init-answers-path': { key: 'initAnswersPath', type: 'string' },
        '--repo-url': { key: 'repoUrl', type: 'string' },
        '--branch': { key: 'branch', type: 'string' },
        '--check-only': { key: 'checkOnly', type: 'boolean' },
        '--no-prompt': { key: 'noPrompt', type: 'boolean' },
        '--dry-run': { key: 'dryRun', type: 'boolean' },
        '--skip-verify': { key: 'skipVerify', type: 'boolean' },
        '--skip-manifest-validation': { key: 'skipManifestValidation', type: 'boolean' },
        '--trust-override': { key: 'trustOverride', type: 'boolean' },
        '--json': { key: 'json', type: 'boolean' }
    };
    const { options: rawOptions } = parseOptions(commandArgv, updateGitDefinitions);
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
    const bundlePath = ensureBundleExists(targetRoot, 'update git');
    assertExplicitCliTrustOverride('update git', {
        trustOverride: options.trustOverride === true,
        noPrompt: options.noPrompt === true
    });

    let lifecycleResult: UpdateLifecycleResult | null = null;
    const updateResult = await runUpdateFromGit({
        targetRoot,
        bundleRoot: bundlePath,
        initAnswersPath: typeof options.initAnswersPath === 'string'
            ? options.initAnswersPath
            : getDefaultInitAnswersPath(targetRoot, bundlePath),
        repoUrl: typeof options.repoUrl === 'string' ? options.repoUrl : undefined,
        branch: typeof options.branch === 'string' ? options.branch : undefined,
        checkOnly: options.checkOnly === true,
        noPrompt: options.noPrompt === true,
        dryRun: options.dryRun === true,
        skipVerify: options.skipVerify === true,
        skipManifestValidation: options.skipManifestValidation === true,
        trustOverride: options.trustOverride === true,
        updateRunner(runnerOptions) {
            lifecycleResult = buildUpdateLifecycleRunner(bundlePath, options.dryRun === true)(runnerOptions);
        }
    }) as Record<string, unknown>;
    const mergedUpdateGitResult = mergeUpdateLifecycleOutput(updateResult, lifecycleResult);
    if (options.json === true) {
        console.log(JSON.stringify(mergedUpdateGitResult, null, 2));
    } else {
        formatKeyValueOutput(mergedUpdateGitResult, [
            'targetRoot', 'repoUrl', 'branch', 'sourceType', 'sourceReference',
            'currentVersion', 'latestVersion', 'updateAvailable',
            'updateApplied', 'checkUpdateResult', 'trustPolicy', 'trustOverrideUsed', 'trustOverrideSource',
            'previousVersion', 'updatedVersion', 'rollbackSnapshotPath', 'rollbackStatus', 'updateReportPath'
        ]);
    }
}

export async function handleCheckUpdate(commandArgv: string[], packageJson: PackageJsonLike): Promise<void> {
    const checkUpdateDefinitions = {
        '--target-root': { key: 'targetRoot', type: 'string' },
        '--init-answers-path': { key: 'initAnswersPath', type: 'string' },
        '--package-spec': { key: 'packageSpec', type: 'string' },
        '--source-path': { key: 'sourcePath', type: 'string' },
        '--apply': { key: 'apply', type: 'boolean' },
        '--no-prompt': { key: 'noPrompt', type: 'boolean' },
        '--dry-run': { key: 'dryRun', type: 'boolean' },
        '--skip-verify': { key: 'skipVerify', type: 'boolean' },
        '--skip-manifest-validation': { key: 'skipManifestValidation', type: 'boolean' },
        '--trust-override': { key: 'trustOverride', type: 'boolean' },
        '--json': { key: 'json', type: 'boolean' }
    };
    const { options: rawOptions } = parseOptions(commandArgv, checkUpdateDefinitions);
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
    const bundlePath = ensureBundleExists(targetRoot, 'check-update');
    assertExplicitCliTrustOverride('check-update', {
        trustOverride: options.trustOverride === true,
        noPrompt: options.noPrompt === true
    });

    let lifecycleResult: UpdateLifecycleResult | null = null;
    const checkResult = await runCheckUpdate({
        targetRoot,
        bundleRoot: bundlePath,
        initAnswersPath: typeof options.initAnswersPath === 'string'
            ? options.initAnswersPath
            : getDefaultInitAnswersPath(targetRoot, bundlePath),
        packageSpec: typeof options.packageSpec === 'string' ? options.packageSpec : undefined,
        sourcePath: typeof options.sourcePath === 'string' ? options.sourcePath : undefined,
        apply: options.apply === true,
        noPrompt: options.noPrompt === true,
        dryRun: options.dryRun === true,
        skipVerify: options.skipVerify === true,
        skipManifestValidation: options.skipManifestValidation === true,
        trustOverride: options.trustOverride === true,
        updateRunner(runnerOptions) {
            lifecycleResult = buildUpdateLifecycleRunner(bundlePath, options.dryRun === true)(runnerOptions);
        }
    });
    const mergedCheckResult = mergeUpdateLifecycleOutput(toKeyValueRecord(checkResult), lifecycleResult);
    if (options.json === true) {
        console.log(JSON.stringify(mergedCheckResult, null, 2));
    } else {
        formatKeyValueOutput(mergedCheckResult, [
            'targetRoot', 'sourceType', 'sourceReference', 'packageSpec', 'sourcePath',
            'currentVersion', 'latestVersion', 'updateAvailable',
            'checkUpdateResult', 'trustPolicy', 'trustOverrideUsed', 'trustOverrideSource', 'previousVersion', 'updatedVersion',
            'rollbackSnapshotPath', 'rollbackStatus', 'updateReportPath'
        ]);
    }
}

export async function handleRollback(commandArgv: string[], packageJson: PackageJsonLike): Promise<void> {
    const rollbackDefinitions = {
        '--target-root': { key: 'targetRoot', type: 'string' },
        '--snapshot-path': { key: 'snapshotPath', type: 'string' },
        '--to-version': { key: 'toVersion', type: 'string' },
        '--init-answers-path': { key: 'initAnswersPath', type: 'string' },
        '--source-path': { key: 'sourcePath', type: 'string' },
        '--package-spec': { key: 'packageSpec', type: 'string' },
        '--dry-run': { key: 'dryRun', type: 'boolean' },
        '--json': { key: 'json', type: 'boolean' }
    };
    const { options: rawOptions } = parseOptions(commandArgv, rollbackDefinitions);
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
    const bundlePath = ensureBundleExists(targetRoot, 'rollback');

    const rollbackResult = await runRollback({
        targetRoot,
        bundleRoot: bundlePath,
        snapshotPath: typeof options.snapshotPath === 'string' ? options.snapshotPath : undefined,
        targetVersion: typeof options.toVersion === 'string' ? options.toVersion : undefined,
        sourcePath: typeof options.sourcePath === 'string' ? options.sourcePath : undefined,
        packageSpec: typeof options.packageSpec === 'string' ? options.packageSpec : undefined,
        initAnswersPath: typeof options.initAnswersPath === 'string'
            ? options.initAnswersPath
            : getDefaultInitAnswersPath(targetRoot, bundlePath),
        dryRun: options.dryRun === true
    }) as Record<string, unknown>;

    if (options.json === true) {
        console.log(JSON.stringify(rollbackResult, null, 2));
        return;
    }

    if (rollbackResult.rollbackMode === 'version') {
        formatKeyValueOutput(rollbackResult, [
            'targetRoot', 'rollbackMode', 'targetVersion',
            'sourceType', 'sourceReference', 'sourceVersion',
            'currentVersion', 'rollbackVersion', 'updatedVersion',
            'restoreStatus', 'syncStatus', 'installStatus', 'materializationStatus',
            'safetySnapshotPath', 'safetySnapshotRecordsPath', 'safetyRollbackStatus',
            'bundleSyncBackupPath', 'rollbackReportPath'
        ]);
        return;
    }

    formatKeyValueOutput(rollbackResult, [
        'targetRoot', 'rollbackMode', 'snapshotPath', 'rollbackRecordsPath', 'rollbackRecordCount',
        'currentVersion', 'snapshotVersion', 'rollbackVersion', 'updatedVersion', 'restoreStatus',
        'bundleBackupPath', 'bundleBackupMetadataPath', 'bundleRestoreStatus',
        'safetySnapshotPath', 'safetySnapshotRecordsPath', 'safetyRollbackStatus',
        'rollbackReportPath'
    ]);
}

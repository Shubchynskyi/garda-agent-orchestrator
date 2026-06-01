import * as path from 'node:path';
import { resolveBundleName } from '../core/constants';
import { pathExists } from '../core/filesystem';
import { getTimestamp, validateTargetRoot } from './common';
import { assertUpdateApplyAllowedInSwitchMode } from './update-off-mode';
import {
    applyAvailableUpdate,
    applyUpdateAvailabilitySnapshot,
    evaluateUpdateAvailability,
    readCurrentBundleVersionOrThrow,
    readLatestSourceVersionOrThrow
} from './check-update-bundle-sync';
import { acquireUpdateSource } from './check-update-source';
import { type CheckUpdateOptions, type CheckUpdateResult } from './check-update-types';

export async function runCheckUpdate(options: CheckUpdateOptions): Promise<CheckUpdateResult> {
    const {
        targetRoot,
        bundleRoot,
        initAnswersPath = path.join(resolveBundleName(), 'runtime', 'init-answers.json'),
        packageSpec = null,
        sourcePath = null,
        apply = false,
        noPrompt = false,
        dryRun = false,
        skipVerify = false,
        skipManifestValidation = false,
        trustOverride = false,
        runningScriptPath = null,
        signal = null,
        onProgress = null,
        diagnosticSourceReference = null,
        diagnosticTool = null,
        prevalidatedPathTrustResult = null,
        npmViewRunner = null,
        npmInstallRunner = null,
        installedPackageRootResolver = null,
        updateRunner = null,
        _testHooks = null
    } = options;

    const normalizedTarget = validateTargetRoot(targetRoot, bundleRoot);
    const deployedBundleRoot = path.join(normalizedTarget, resolveBundleName());
    if (!pathExists(deployedBundleRoot)) {
        throw new Error(`Deployed bundle not found: ${deployedBundleRoot}`);
    }
    assertUpdateApplyAllowedInSwitchMode({
        targetRoot: normalizedTarget,
        bundleRoot: deployedBundleRoot,
        applyRequested: apply,
        dryRun,
        commandName: 'update apply'
    });

    const currentVersion = readCurrentBundleVersionOrThrow(deployedBundleRoot);

    const timestamp = getTimestamp();
    const syncBackupRoot = path.join(deployedBundleRoot, 'runtime', 'bundle-backups', timestamp);
    const source = await acquireUpdateSource({
        deployedBundleRoot,
        packageSpec,
        sourcePath,
        trustOverride,
        signal,
        onProgress,
        diagnosticSourceReference,
        diagnosticTool,
        prevalidatedPathTrustResult,
        npmViewRunner,
        npmInstallRunner,
        installedPackageRootResolver
    });

    const result: CheckUpdateResult = {
        targetRoot: normalizedTarget,
        sourceType: source.sourceType,
        sourceReference: source.sourceReference,
        packageSpec: source.packageSpec,
        requestedPackageSpec: source.requestedPackageSpec,
        exactPackageSpec: source.exactPackageSpec,
        resolvedPackageVersion: source.resolvedPackageVersion,
        resolvedPackageIntegrity: source.resolvedPackageIntegrity,
        releaseProvenanceStatus: source.releaseProvenanceStatus,
        releaseProvenanceSummary: source.releaseProvenanceSummary,
        releaseProvenanceRecommendation: source.releaseProvenanceRecommendation,
        sourcePath: source.sourceType === 'path' ? source.sourceReference : null,
        packageName: source.packageName,
        currentVersion,
        latestVersion: null,
        updateAvailable: false,
        versionDiffDetected: false,
        contentDriftDetected: false,
        driftedSyncItems: [],
        applyRequested: apply,
        noPrompt,
        dryRun,
        trustPolicy: source.trustPolicy || 'enforced',
        trustOverrideUsed: source.trustOverrideUsed,
        trustOverrideSource: source.trustOverrideSource || 'none',
        syncItemsDetected: 0,
        syncItemsBackedUp: 0,
        syncItemsUpdated: 0,
        syncBackupRoot: 'not-created',
        syncBackupMetadataPath: 'not-created',
        syncRollbackStatus: 'NOT_NEEDED',
        syncedItems: [],
        updateApplied: false,
        checkUpdateResult: 'UNKNOWN'
    };

    try {
        const effectiveDiagnosticSource = source.diagnosticSourceReference || source.sourceReference;
        const effectiveDiagnosticTool = source.diagnosticTool || source.sourceType || 'update-source';
        const latestVersion = readLatestSourceVersionOrThrow(source.sourceRoot, effectiveDiagnosticSource, effectiveDiagnosticTool);
        result.latestVersion = latestVersion;

        applyUpdateAvailabilitySnapshot(
            result,
            evaluateUpdateAvailability(currentVersion, latestVersion, source.sourceType, source.sourceRoot, deployedBundleRoot)
        );

        if (result.updateAvailable && apply) {
            await applyAvailableUpdate({
                normalizedTarget,
                deployedBundleRoot,
                source,
                result,
                initAnswersPath,
                noPrompt,
                dryRun,
                skipVerify,
                skipManifestValidation,
                runningScriptPath,
                updateRunner,
                testHooks: _testHooks,
                effectiveDiagnosticSource,
                effectiveDiagnosticTool,
                syncBackupRoot
            });
        }
    } finally {
        source.cleanup();
    }

    return result;
}

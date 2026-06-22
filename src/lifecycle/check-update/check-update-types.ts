import type { SpawnStreamedOptions } from '../../core/subprocess';
import type { TrustValidationResult } from '../update/update-trust';

export interface NpmViewResult {
    error?: Error;
    status: number | null;
    stdout?: string | Buffer | null;
    stderr?: string | Buffer | null;
}

export interface NpmInstallResult {
    cancelled?: boolean;
    timedOut?: boolean;
    exitCode: number | null;
    stdout?: string | Buffer | null;
    stderr?: string | Buffer | null;
}

export interface ResolveInstalledPackageRootOptions {
    sourceReference?: string;
}

export interface ResolveNpmUpdateSourceSpecOptions {
    sourceReference?: string | null;
    viewRunner?: ((args: string[]) => NpmViewResult) | null;
}

export interface ResolvedNpmUpdateSource {
    requestedSpec: string;
    exactSpec: string;
    packageName: string | null;
    version: string | null;
    integrity: string | null;
    resolutionMode: 'direct' | 'explicit_exact' | 'resolved';
}

export interface AcquireUpdateSourceOptions {
    deployedBundleRoot: string;
    packageSpec?: string | null;
    sourcePath?: string | null;
    trustOverride?: boolean;
    signal?: AbortSignal | null;
    onProgress?: ((chunk: string) => void) | null;
    diagnosticSourceReference?: string | null;
    diagnosticTool?: string | null;
    prevalidatedPathTrustResult?: TrustValidationResult | null;
    npmViewRunner?: ((args: string[]) => NpmViewResult) | null;
    npmInstallRunner?: ((args: string[], options: SpawnStreamedOptions) => Promise<NpmInstallResult>) | null;
    installedPackageRootResolver?: ((
        tempInstallRoot: string,
        options?: ResolveInstalledPackageRootOptions
    ) => { packageName: string; packageRoot: string }) | null;
}

export interface AcquiredUpdateSource {
    sourceType: 'path' | 'npm';
    sourceReference: string;
    diagnosticSourceReference: string;
    packageSpec: string | null;
    requestedPackageSpec: string | null;
    exactPackageSpec: string | null;
    resolvedPackageVersion: string | null;
    resolvedPackageIntegrity: string | null;
    releaseProvenanceStatus: string | null;
    releaseProvenanceSummary: string | null;
    releaseProvenanceRecommendation: string | null;
    packageName: string | null;
    sourceRoot: string;
    trustPolicy: string;
    trustOverrideUsed: boolean;
    trustOverrideSource: string;
    diagnosticTool: string;
    cleanup: () => void;
}

export interface CheckUpdateRunnerOptions {
    targetRoot: string;
    initAnswersPath: string;
    noPrompt: boolean;
    skipVerify: boolean;
    skipManifestValidation: boolean;
    trustPolicy: string;
    trustOverrideUsed: boolean;
    trustOverrideSource: string;
    sourceType: string;
    sourceReference: string;
    gitCommitSha?: string | null;
    requestedPackageSpec?: string | null;
    exactPackageSpec?: string | null;
    resolvedPackageVersion?: string | null;
    resolvedPackageIntegrity?: string | null;
    releaseProvenanceStatus?: string | null;
    releaseProvenanceSummary?: string | null;
    releaseProvenanceRecommendation?: string | null;
    lifecycleLockAlreadyHeld?: boolean;
}

export interface CheckUpdateTestHooks {
    beforeSyncItemFaultInjector?: ((item: string, index: number) => void) | null;
    syncItemFaultInjector?: ((item: string, index: number) => void) | null;
    afterDeferredVersionSync?: (() => void) | null;
}

export interface CheckUpdateOptions {
    targetRoot: string;
    bundleRoot: string;
    initAnswersPath?: string;
    packageSpec?: string | null;
    sourcePath?: string | null;
    apply?: boolean;
    noPrompt?: boolean;
    dryRun?: boolean;
    skipVerify?: boolean;
    skipManifestValidation?: boolean;
    trustOverride?: boolean;
    runningScriptPath?: string | null;
    signal?: AbortSignal | null;
    onProgress?: ((chunk: string) => void) | null;
    diagnosticSourceReference?: string | null;
    diagnosticTool?: string | null;
    prevalidatedPathTrustResult?: TrustValidationResult | null;
    npmViewRunner?: ((args: string[]) => NpmViewResult) | null;
    npmInstallRunner?: ((args: string[], options: SpawnStreamedOptions) => Promise<NpmInstallResult>) | null;
    installedPackageRootResolver?: ((
        tempInstallRoot: string,
        options?: ResolveInstalledPackageRootOptions
    ) => { packageName: string; packageRoot: string }) | null;
    updateRunner?: ((options: CheckUpdateRunnerOptions) => void) | null;
    _testHooks?: CheckUpdateTestHooks | null;
}

export interface CheckUpdateResult {
    targetRoot: string;
    sourceType: string;
    sourceReference: string;
    packageSpec: string | null;
    requestedPackageSpec: string | null;
    exactPackageSpec: string | null;
    resolvedPackageVersion: string | null;
    resolvedPackageIntegrity: string | null;
    releaseProvenanceStatus: string | null;
    releaseProvenanceSummary: string | null;
    releaseProvenanceRecommendation: string | null;
    sourcePath: string | null;
    packageName: string | null;
    currentVersion: string;
    latestVersion: string | null;
    updateAvailable: boolean;
    versionDiffDetected: boolean;
    contentDriftDetected: boolean;
    driftedSyncItems: string[];
    applyRequested: boolean;
    noPrompt: boolean;
    dryRun: boolean;
    trustPolicy: string;
    trustOverrideUsed: boolean;
    trustOverrideSource: string;
    syncItemsDetected: number;
    syncItemsBackedUp: number;
    syncItemsUpdated: number;
    syncBackupRoot: string;
    syncBackupMetadataPath: string;
    syncRollbackStatus: string;
    syncedItems: string[];
    updateApplied: boolean;
    checkUpdateResult: string;
}

export interface UpdateAvailabilitySnapshot {
    currentVersion: string;
    versionDiffDetected: boolean;
    contentDriftDetected: boolean;
    driftedSyncItems: string[];
    updateAvailable: boolean;
    checkUpdateResult: string;
}

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PRIMARY_PACKAGE_NAME, resolveBundleName } from '../core/constants';
import { pathExists, readTextFile } from '../core/fs';
import {
    DEFAULT_NPM_TIMEOUT_MS,
    spawnStreamed,
    spawnSyncWithTimeout,
    type SpawnStreamedOptions,
    type SpawnSyncWithTimeoutOptions
} from '../core/subprocess';
import {
    BUNDLE_SYNC_ITEMS,
    compareVersionStrings,
    copyDirectoryContentMerge,
    copyPathRecursive,
    getTimestamp,
    removePathRecursive,
    removeUpdateSentinel,
    readdirRecursiveFiles,
    restoreSyncedItemsFromBackup,
    writeSyncBackupMetadata,
    writeUpdateSentinel,
    validateTargetRoot,
    withLifecycleOperationLockAsync
} from './common';
import {
    type TrustValidationResult,
    validateNpmSourceTrust,
    validatePathSourceTrust
} from './update-trust';
import { classifyNpmDiagnostic, createLifecycleDiagnosticError } from './update-diagnostics';

export const DEFAULT_PACKAGE_NAME = PRIMARY_PACKAGE_NAME;

interface NpmInvocation {
    command: string;
    prefixArgs: string[];
}

interface ResolveInstalledPackageRootOptions {
    sourceReference?: string;
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
}

export interface AcquiredUpdateSource {
    sourceType: 'path' | 'npm';
    sourceReference: string;
    diagnosticSourceReference: string;
    packageSpec: string | null;
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
    lifecycleLockAlreadyHeld?: boolean;
}

interface CheckUpdateOptions {
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
    updateRunner?: ((options: CheckUpdateRunnerOptions) => void) | null;
}

interface CheckUpdateResult {
    targetRoot: string;
    sourceType: string;
    sourceReference: string;
    packageSpec: string | null;
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

interface UpdateAvailabilitySnapshot {
    currentVersion: string;
    versionDiffDetected: boolean;
    contentDriftDetected: boolean;
    driftedSyncItems: string[];
    updateAvailable: boolean;
    checkUpdateResult: string;
}

function syncDeferredLiveVersionPayload(bundleRoot: string, version: string): void {
    const liveVersionPath = path.join(bundleRoot, 'live', 'version.json');
    if (!pathExists(liveVersionPath)) {
        return;
    }

    try {
        const parsed = toObjectRecord(JSON.parse(readTextFile(liveVersionPath))) || {};
        parsed.Version = version;
        parsed.UpdatedAt = new Date().toISOString();
        fs.writeFileSync(liveVersionPath, JSON.stringify(parsed, null, 2) + '\n', 'utf8');
    } catch (_error) {
        // Keep update success path stable when historical live/version.json is malformed.
        // Verification will still surface the malformed payload if it remains unreadable.
    }
}

function toObjectRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
}

function getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function listRelativeFiles(directoryPath: string): string[] {
    return readdirRecursiveFiles(directoryPath)
        .map((filePath) => path.relative(directoryPath, filePath).replace(/\\/g, '/'))
        .sort();
}

function areFilesEquivalent(leftPath: string, rightPath: string): boolean {
    const leftStats = fs.lstatSync(leftPath);
    const rightStats = fs.lstatSync(rightPath);

    if (leftStats.isSymbolicLink() || rightStats.isSymbolicLink()) {
        return leftStats.isSymbolicLink()
            && rightStats.isSymbolicLink()
            && fs.readlinkSync(leftPath) === fs.readlinkSync(rightPath);
    }

    if (!leftStats.isFile() || !rightStats.isFile()) {
        return false;
    }

    if (leftStats.size !== rightStats.size) {
        return false;
    }

    return fs.readFileSync(leftPath).equals(fs.readFileSync(rightPath));
}

function areDirectoriesEquivalent(
    sourceDirectory: string,
    destinationDirectory: string,
    options: { allowExtraDestinationFiles: boolean }
): boolean {
    if (!fs.existsSync(destinationDirectory) || !fs.lstatSync(destinationDirectory).isDirectory()) {
        return false;
    }

    const sourceFiles = listRelativeFiles(sourceDirectory);
    const destinationFiles = listRelativeFiles(destinationDirectory);
    const destinationFileSet = new Set(destinationFiles);

    for (const relativeFile of sourceFiles) {
        if (!destinationFileSet.has(relativeFile)) {
            return false;
        }

        if (!areFilesEquivalent(
            path.join(sourceDirectory, relativeFile),
            path.join(destinationDirectory, relativeFile)
        )) {
            return false;
        }
    }

    if (!options.allowExtraDestinationFiles && sourceFiles.length !== destinationFiles.length) {
        return false;
    }

    return true;
}

function doesSyncItemMatchSource(sourceRoot: string, deployedBundleRoot: string, item: string): boolean {
    const sourceItemPath = path.join(sourceRoot, item);
    if (!fs.existsSync(sourceItemPath)) {
        return true;
    }

    const deployedItemPath = path.join(deployedBundleRoot, item);
    if (!fs.existsSync(deployedItemPath)) {
        return false;
    }

    const sourceStats = fs.lstatSync(sourceItemPath);
    const deployedStats = fs.lstatSync(deployedItemPath);
    if (sourceStats.isDirectory() !== deployedStats.isDirectory()) {
        return false;
    }

    if (sourceStats.isDirectory()) {
        return areDirectoriesEquivalent(sourceItemPath, deployedItemPath, {
            allowExtraDestinationFiles: item.toLowerCase() === 'src'
        });
    }

    return areFilesEquivalent(sourceItemPath, deployedItemPath);
}

function detectSyncSurfaceDrift(sourceRoot: string, deployedBundleRoot: string): string[] {
    const driftedItems: string[] = [];

    for (const item of BUNDLE_SYNC_ITEMS) {
        if (!doesSyncItemMatchSource(sourceRoot, deployedBundleRoot, item)) {
            driftedItems.push(item);
        }
    }

    return driftedItems;
}

function readCurrentBundleVersionOrThrow(deployedBundleRoot: string): string {
    const currentVersionPath = path.join(deployedBundleRoot, 'VERSION');
    if (!pathExists(currentVersionPath)) {
        throw new Error(`Current VERSION file not found: ${currentVersionPath}`);
    }

    const currentVersion = readTextFile(currentVersionPath).trim();
    if (!currentVersion) {
        throw new Error(`Current VERSION file is empty: ${currentVersionPath}`);
    }

    return currentVersion;
}

function readLatestSourceVersionOrThrow(
    sourceRoot: string,
    effectiveDiagnosticSource: string,
    effectiveDiagnosticTool: string
): string {
    const latestVersionPath = path.join(sourceRoot, 'VERSION');
    if (!pathExists(latestVersionPath)) {
        throw createLifecycleDiagnosticError({
            message: `Latest VERSION file not found in update source '${effectiveDiagnosticSource}'.`,
            tool: effectiveDiagnosticTool,
            code: 'UPDATE_SOURCE_VERSION_MISSING',
            sourceReference: effectiveDiagnosticSource,
            detailText: latestVersionPath
        });
    }

    const latestVersion = readTextFile(latestVersionPath).trim();
    if (!latestVersion) {
        throw createLifecycleDiagnosticError({
            message: `Latest VERSION file is empty in update source '${effectiveDiagnosticSource}'.`,
            tool: effectiveDiagnosticTool,
            code: 'UPDATE_SOURCE_VERSION_EMPTY',
            sourceReference: effectiveDiagnosticSource,
            detailText: latestVersionPath
        });
    }

    return latestVersion;
}

function evaluateUpdateAvailability(
    currentVersion: string,
    latestVersion: string,
    sourceType: AcquiredUpdateSource['sourceType'],
    sourceRoot: string,
    deployedBundleRoot: string
): UpdateAvailabilitySnapshot {
    const comparison = compareVersionStrings(currentVersion, latestVersion);
    const versionDiffDetected = comparison < 0;
    const driftedSyncItems = comparison === 0 && sourceType === 'path'
        ? detectSyncSurfaceDrift(sourceRoot, deployedBundleRoot)
        : [];
    const contentDriftDetected = driftedSyncItems.length > 0;
    const updateAvailable = versionDiffDetected || contentDriftDetected;

    return {
        currentVersion,
        versionDiffDetected,
        contentDriftDetected,
        driftedSyncItems,
        updateAvailable,
        checkUpdateResult: updateAvailable ? 'UPDATE_AVAILABLE' : 'UP_TO_DATE'
    };
}

function applyUpdateAvailabilitySnapshot(
    result: CheckUpdateResult,
    snapshot: UpdateAvailabilitySnapshot
): void {
    result.currentVersion = snapshot.currentVersion;
    result.versionDiffDetected = snapshot.versionDiffDetected;
    result.contentDriftDetected = snapshot.contentDriftDetected;
    result.driftedSyncItems = snapshot.driftedSyncItems;
    result.updateAvailable = snapshot.updateAvailable;
    result.checkUpdateResult = snapshot.checkUpdateResult;
}

let resolvedNpmInvocation: NpmInvocation | null = null;

function resolveNpmInvocation(): NpmInvocation {
    if (resolvedNpmInvocation) {
        return resolvedNpmInvocation;
    }

    const npmExecPath = String(process.env.npm_execpath || '').trim();
    if (npmExecPath && pathExists(npmExecPath)) {
        resolvedNpmInvocation = {
            command: process.execPath,
            prefixArgs: [npmExecPath]
        };
        return resolvedNpmInvocation;
    }

    const bundledCandidates = [
        path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
        path.join(path.dirname(process.execPath), '..', 'node_modules', 'npm', 'bin', 'npm-cli.js')
    ];

    for (const candidate of bundledCandidates) {
        const resolvedCandidate = path.resolve(candidate);
        if (pathExists(resolvedCandidate)) {
            resolvedNpmInvocation = {
                command: process.execPath,
                prefixArgs: [resolvedCandidate]
            };
            return resolvedNpmInvocation;
        }
    }

    resolvedNpmInvocation = {
        command: 'npm',
        prefixArgs: []
    };
    return resolvedNpmInvocation;
}

function runNpmSync(args: string[], options: SpawnSyncWithTimeoutOptions = {}) {
    const {
        encoding = 'utf8',
        stdio = 'pipe'
    } = options;

    const invocation = resolveNpmInvocation();

    return spawnSyncWithTimeout(invocation.command, [...invocation.prefixArgs, ...args], {
        ...options,
        encoding,
        stdio,
        windowsHide: true,
        timeoutMs: DEFAULT_NPM_TIMEOUT_MS
    });
}

async function runNpmStreamed(args: string[], options: SpawnStreamedOptions = {}) {
    const invocation = resolveNpmInvocation();
    const timeoutMs = typeof options.timeoutMs === 'number' ? options.timeoutMs : DEFAULT_NPM_TIMEOUT_MS;

    return spawnStreamed(invocation.command, [...invocation.prefixArgs, ...args], {
        cwd: options.cwd,
        timeoutMs,
        signal: options.signal ?? undefined,
        onStdout: options.onStdout ?? undefined,
        onStderr: options.onStderr ?? undefined
    });
}

function readPackageNameFromDirectory(directoryPath: string, fallbackValue: string | null = null): string | null {
    const packageJsonPath = path.join(directoryPath, 'package.json');
    if (!pathExists(packageJsonPath)) {
        return fallbackValue;
    }

    try {
        const parsed = toObjectRecord(JSON.parse(readTextFile(packageJsonPath)));
        const name = String(parsed && parsed.name ? parsed.name : '').trim();
        return name || fallbackValue;
    } catch (_error) {
        return fallbackValue;
    }
}

function resolveNodeModulesPackageRoot(nodeModulesRoot: string, packageName: string): string {
    return path.join(nodeModulesRoot, ...packageName.split('/'));
}

function resolveInstalledPackageRoot(
    tempInstallRoot: string,
    options: ResolveInstalledPackageRootOptions = {}
): { packageName: string; packageRoot: string } {
    const listResult = runNpmSync([
        'ls',
        '--json',
        '--depth=0',
        '--prefix',
        tempInstallRoot
    ]);

    const sourceReference = String(options.sourceReference || tempInstallRoot);
    const detailText = listResult.error ? getErrorMessage(listResult.error) : '';
    if (listResult.error || listResult.status !== 0) {
        throw createLifecycleDiagnosticError({
            message: `Failed to inspect installed update package metadata for '${sourceReference}'.`,
            tool: 'npm',
            code: 'NPM_METADATA_UNAVAILABLE',
            sourceReference,
            stderr: listResult.stderr,
            stdout: listResult.stdout,
            detailText
        });
    }

    const stdout = String(listResult.stdout || '').trim();
    if (!stdout) {
        throw createLifecycleDiagnosticError({
            message: `Failed to resolve installed update package metadata for '${sourceReference}'.`,
            tool: 'npm',
            code: 'NPM_METADATA_EMPTY',
            sourceReference,
            stderr: listResult.stderr,
            stdout: listResult.stdout
        });
    }

    let parsed: Record<string, unknown> = {};
    try {
        parsed = toObjectRecord(JSON.parse(stdout)) || {};
    } catch (_error) {
        throw createLifecycleDiagnosticError({
            message: `Failed to parse installed update package metadata for '${sourceReference}'.`,
            tool: 'npm',
            code: 'NPM_METADATA_INVALID',
            sourceReference,
            stdout
        });
    }

    const dependencyMap = toObjectRecord(parsed.dependencies) || {};
    const dependencyNames = Object.keys(dependencyMap);
    if (dependencyNames.length === 0) {
        throw createLifecycleDiagnosticError({
            message: `Installed update package metadata did not contain any top-level dependencies for '${sourceReference}'.`,
            tool: 'npm',
            code: 'NPM_METADATA_INVALID',
            sourceReference,
            stdout
        });
    }

    const packageName = dependencyNames[0];
    const packageRoot = resolveNodeModulesPackageRoot(path.join(tempInstallRoot, 'node_modules'), packageName);
    if (!pathExists(packageRoot)) {
        throw createLifecycleDiagnosticError({
            message: `Installed update package root not found for '${sourceReference}'.`,
            tool: 'npm',
            code: 'NPM_METADATA_INVALID',
            sourceReference,
            detailText: packageRoot
        });
    }

    return {
        packageName,
        packageRoot
    };
}

export async function acquireUpdateSource(options: AcquireUpdateSourceOptions): Promise<AcquiredUpdateSource> {
    const {
        deployedBundleRoot,
        packageSpec,
        sourcePath,
        trustOverride = false,
        signal = null,
        onProgress = null,
        diagnosticSourceReference = null,
        diagnosticTool = null,
        prevalidatedPathTrustResult = null
    } = options;

    if (packageSpec && sourcePath) {
        throw new Error('Provide either packageSpec or sourcePath for check-update, not both.');
    }

    if (sourcePath) {
        const trustResult = prevalidatedPathTrustResult || validatePathSourceTrust(sourcePath, { trustOverride });
        const resolvedSourcePath = path.resolve(String(sourcePath).trim());
        if (!pathExists(resolvedSourcePath)) {
            throw new Error(`Update source path not found: ${resolvedSourcePath}`);
        }

        const stats = fs.lstatSync(resolvedSourcePath);
        if (!stats.isDirectory()) {
            throw new Error(`Update source path must be a directory: ${resolvedSourcePath}`);
        }

        return {
            sourceType: 'path',
            sourceReference: resolvedSourcePath,
            diagnosticSourceReference: diagnosticSourceReference || resolvedSourcePath,
            packageSpec: null,
            packageName: readPackageNameFromDirectory(resolvedSourcePath),
            sourceRoot: resolvedSourcePath,
            trustPolicy: trustResult.policy,
            trustOverrideUsed: trustResult.overridden,
            trustOverrideSource: trustResult.overrideSource || 'none',
            diagnosticTool: diagnosticTool || 'path',
            cleanup() {}
        };
    }

    const versionResult = runNpmSync(['--version'], { stdio: 'pipe' });
    const versionDetailText = versionResult.error ? getErrorMessage(versionResult.error) : '';
    if (versionResult.error || versionResult.status !== 0) {
        throw createLifecycleDiagnosticError({
            message: 'npm is required for npm-based check-update workflow.',
            tool: 'npm',
            code: 'NPM_NOT_AVAILABLE',
            sourceReference: diagnosticSourceReference || 'npm',
            stderr: versionResult.stderr,
            stdout: versionResult.stdout,
            detailText: versionDetailText
        });
    }

    const deployedPackageName = readPackageNameFromDirectory(deployedBundleRoot, DEFAULT_PACKAGE_NAME) || DEFAULT_PACKAGE_NAME;
    const effectivePackageSpec = String(packageSpec || `${deployedPackageName}@latest`).trim();
    const effectiveDiagnosticSource = diagnosticSourceReference || effectivePackageSpec;

    const trustResult = validateNpmSourceTrust(effectivePackageSpec, { trustOverride });

    const tempInstallRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-update-npm-'));

    try {
        const installArgs = [
            'install',
            '--prefix',
            tempInstallRoot,
            '--no-save',
            '--ignore-scripts',
            '--package-lock=false',
            '--fund=false',
            '--audit=false',
            effectivePackageSpec
        ];
        const installResult = await runNpmStreamed(installArgs, {
            signal: signal ?? undefined,
            onStderr: onProgress ?? undefined
        });

        if (installResult.cancelled) {
            throw createLifecycleDiagnosticError({
                message: `npm install was cancelled for '${effectivePackageSpec}'.`,
                tool: 'npm',
                code: 'NPM_INSTALL_CANCELLED',
                sourceReference: effectiveDiagnosticSource,
                stderr: installResult.stderr,
                stdout: installResult.stdout
            });
        }

        if (installResult.timedOut) {
            throw createLifecycleDiagnosticError({
                message: `npm install timed out after ${DEFAULT_NPM_TIMEOUT_MS} ms for '${effectivePackageSpec}'.`,
                tool: 'npm',
                code: 'NPM_INSTALL_TIMEOUT',
                sourceReference: effectiveDiagnosticSource,
                stderr: installResult.stderr,
                stdout: installResult.stdout
            });
        }

        if (installResult.exitCode !== 0) {
            const diagnosticText = `${String(installResult.stderr || '')}\n${String(installResult.stdout || '')}`;
            throw createLifecycleDiagnosticError({
                message: `Failed to install update package '${effectivePackageSpec}'.`,
                tool: 'npm',
                code: classifyNpmDiagnostic(diagnosticText),
                sourceReference: effectiveDiagnosticSource,
                stderr: installResult.stderr,
                stdout: installResult.stdout
            });
        }

        const installed = resolveInstalledPackageRoot(tempInstallRoot, { sourceReference: effectiveDiagnosticSource });
        return {
            sourceType: 'npm',
            sourceReference: effectivePackageSpec,
            diagnosticSourceReference: effectiveDiagnosticSource,
            packageSpec: effectivePackageSpec,
            packageName: installed.packageName,
            sourceRoot: installed.packageRoot,
            trustPolicy: trustResult.policy,
            trustOverrideUsed: trustResult.overridden,
            trustOverrideSource: trustResult.overrideSource || 'none',
            diagnosticTool: diagnosticTool || 'npm',
            cleanup() {
                removePathRecursive(tempInstallRoot);
            }
        };
    } catch (error: unknown) {
        removePathRecursive(tempInstallRoot);
        throw error;
    }
}

/**
 * Runs the check-update pipeline.
 * Node implementation of the check-update lifecycle.
 *
 * @param {object} options
 * @param {string} options.targetRoot - Project root directory
 * @param {string} options.bundleRoot - Orchestrator bundle directory (deployed)
 * @param {string} [options.initAnswersPath]
 * @param {string} [options.packageSpec]
 * @param {string} [options.sourcePath]
 * @param {boolean} [options.apply=false]
 * @param {boolean} [options.noPrompt=false]
 * @param {boolean} [options.dryRun=false]
 * @param {boolean} [options.skipVerify=false]
 * @param {boolean} [options.skipManifestValidation=false]
 * @param {boolean} [options.trustOverride=false] - When true, bypass update source trust policy
 * @param {string} [options.runningScriptPath] - Path of the currently running script (for skip during merge)
 * @param {AbortSignal}  [options.signal]         External cancellation signal for npm operations
 * @param {Function}    [options.onProgress]     Progress callback for streamed npm output
 * @param {string}      [options.diagnosticSourceReference] - User-facing source label for diagnostics
 * @param {string}      [options.diagnosticTool] - Tool label for diagnostics
 * @param {Function} [options.updateRunner] - Callback that performs the post-sync update step
 * @returns {Promise<object>} Check-update result
 */
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
        updateRunner = null
    } = options;

    const normalizedTarget = validateTargetRoot(targetRoot, bundleRoot);
    const deployedBundleRoot = path.join(normalizedTarget, resolveBundleName());
    if (!pathExists(deployedBundleRoot)) {
        throw new Error(`Deployed bundle not found: ${deployedBundleRoot}`);
    }

    let currentVersion = readCurrentBundleVersionOrThrow(deployedBundleRoot);

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
        prevalidatedPathTrustResult
    });

    const result: CheckUpdateResult = {
        targetRoot: normalizedTarget,
        sourceType: source.sourceType,
        sourceReference: source.sourceReference,
        packageSpec: source.packageSpec,
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
        trustOverrideUsed: source.trustOverrideUsed === true,
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
        let latestVersion = readLatestSourceVersionOrThrow(source.sourceRoot, effectiveDiagnosticSource, effectiveDiagnosticTool);
        result.latestVersion = latestVersion;

        applyUpdateAvailabilitySnapshot(
            result,
            evaluateUpdateAvailability(currentVersion, latestVersion, source.sourceType, source.sourceRoot, deployedBundleRoot)
        );

        if (result.updateAvailable && apply) {
            await withLifecycleOperationLockAsync(normalizedTarget, 'update', async () => {
            currentVersion = readCurrentBundleVersionOrThrow(deployedBundleRoot);
            latestVersion = readLatestSourceVersionOrThrow(source.sourceRoot, effectiveDiagnosticSource, effectiveDiagnosticTool);
            result.latestVersion = latestVersion;
            applyUpdateAvailabilitySnapshot(
                result,
                evaluateUpdateAvailability(currentVersion, latestVersion, source.sourceType, source.sourceRoot, deployedBundleRoot)
            );

            if (!result.updateAvailable) {
                return;
            }

            const syncPreexistingMap: Record<string, boolean> = {};
            const DEFERRED_VERSION_ITEM = 'VERSION';

            try {
                for (const item of BUNDLE_SYNC_ITEMS) {
                    const sourceItemPath = path.join(source.sourceRoot, item);
                    if (!fs.existsSync(sourceItemPath)) continue;

                    result.syncItemsDetected++;
                    const destinationPath = path.join(deployedBundleRoot, item);
                    const destinationExists = fs.existsSync(destinationPath);

                    if (dryRun) {
                        result.syncedItems.push(item);
                        continue;
                    }

                    // Defer VERSION until after lifecycle to prevent the workspace
                    // from appearing updated before lifecycle has completed.
                    if (item === DEFERRED_VERSION_ITEM) {
                        continue;
                    }

                    if (!(item in syncPreexistingMap)) {
                        syncPreexistingMap[item] = destinationExists;
                    }

                    if (destinationExists) {
                        const backupPath = path.join(syncBackupRoot, item);
                        fs.mkdirSync(path.dirname(backupPath), { recursive: true });
                        copyPathRecursive(destinationPath, backupPath);
                        result.syncItemsBackedUp++;
                        result.syncBackupRoot = syncBackupRoot;
                    }

                    const sourceIsDirectory = fs.lstatSync(sourceItemPath).isDirectory();
                    const isNodeRuntimeDir = item.toLowerCase() === 'src';

                    if (sourceIsDirectory) {
                        if (isNodeRuntimeDir) {
                            if (!fs.existsSync(destinationPath) || !fs.lstatSync(destinationPath).isDirectory()) {
                                removePathRecursive(destinationPath);
                                fs.mkdirSync(destinationPath, { recursive: true });
                            }
                            const skipPaths = runningScriptPath ? [path.resolve(runningScriptPath)] : [];
                            copyDirectoryContentMerge(sourceItemPath, destinationPath, skipPaths);
                        } else {
                            removePathRecursive(destinationPath);
                            copyPathRecursive(sourceItemPath, destinationPath);
                        }
                    } else {
                        removePathRecursive(destinationPath);
                        fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
                        fs.copyFileSync(sourceItemPath, destinationPath);
                    }

                    result.syncItemsUpdated++;
                    result.syncedItems.push(item);
                }

                if (!dryRun && Object.keys(syncPreexistingMap).length > 0) {
                    const syncMetadataPath = writeSyncBackupMetadata(syncBackupRoot, {
                        createdAt: new Date().toISOString(),
                        sourceType: source.sourceType,
                        sourceReference: source.sourceReference,
                        packageSpec: source.packageSpec,
                        preexistingMap: syncPreexistingMap
                    });
                    result.syncBackupRoot = syncBackupRoot;
                    result.syncBackupMetadataPath = syncMetadataPath;
                }

                if (!dryRun) {
                    // Write sentinel before lifecycle to allow detection of interrupted updates
                    writeUpdateSentinel(deployedBundleRoot, {
                        startedAt: new Date().toISOString(),
                        fromVersion: currentVersion,
                        toVersion: latestVersion
                    });

                    if (updateRunner) {
                        updateRunner({
                            targetRoot: normalizedTarget,
                            initAnswersPath,
                            noPrompt,
                            skipVerify,
                            skipManifestValidation,
                            trustPolicy: result.trustPolicy,
                            trustOverrideUsed: result.trustOverrideUsed,
                            trustOverrideSource: result.trustOverrideSource,
                            sourceType: result.sourceType,
                            sourceReference: result.sourceReference,
                            lifecycleLockAlreadyHeld: true
                        });
                    }

                    // Sync deferred VERSION only after lifecycle has completed successfully.
                    // This ensures the workspace version does not advance until the full
                    // lifecycle (materialization, verify, etc.) is finished.
                    const versionSourcePath = path.join(source.sourceRoot, DEFERRED_VERSION_ITEM);
                    if (fs.existsSync(versionSourcePath)) {
                        const versionDestPath = path.join(deployedBundleRoot, DEFERRED_VERSION_ITEM);
                        // Preserve the previous VERSION so it can be restored if the
                        // deferred copy fails.  VERSION is not part of the regular
                        // syncPreexistingMap, so without this guard the old file would
                        // be lost on a late failure (T-092).
                        const previousVersionContent = fs.existsSync(versionDestPath)
                            ? fs.readFileSync(versionDestPath)
                            : null;
                        try {
                            removePathRecursive(versionDestPath);
                            fs.mkdirSync(path.dirname(versionDestPath), { recursive: true });
                            fs.copyFileSync(versionSourcePath, versionDestPath);
                        } catch (versionSyncError) {
                            // Restore the previous VERSION to keep the workspace consistent.
                            if (previousVersionContent !== null) {
                                try {
                                    fs.mkdirSync(path.dirname(versionDestPath), { recursive: true });
                                    fs.writeFileSync(versionDestPath, previousVersionContent);
                                } catch (_restoreErr) {
                                    // Best-effort restore; the outer catch will report the
                                    // original failure which already triggers a full rollback.
                                }
                            }
                            throw versionSyncError;
                        }
                        result.syncItemsUpdated++;
                        result.syncedItems.push(DEFERRED_VERSION_ITEM);
                        syncDeferredLiveVersionPayload(deployedBundleRoot, readTextFile(versionDestPath).trim());
                    }

                    removeUpdateSentinel(deployedBundleRoot);

                    result.updateApplied = true;
                    result.checkUpdateResult = 'UPDATED';
                    if (Object.keys(syncPreexistingMap).length > 0 && result.syncRollbackStatus === 'NOT_NEEDED') {
                        result.syncRollbackStatus = 'NOT_TRIGGERED';
                    }
                } else {
                    result.checkUpdateResult = 'DRY_RUN_UPDATE_AVAILABLE';
                }
            } catch (applyError) {
                const originalError = getErrorMessage(applyError);
                removeUpdateSentinel(deployedBundleRoot);
                if (!dryRun && Object.keys(syncPreexistingMap).length > 0) {
                    result.syncRollbackStatus = 'ATTEMPTED';
                    try {
                        restoreSyncedItemsFromBackup(deployedBundleRoot, syncBackupRoot, syncPreexistingMap, runningScriptPath);
                        result.syncRollbackStatus = 'SUCCESS';
                    } catch (rollbackError: unknown) {
                        const rollbackMsg = getErrorMessage(rollbackError);
                        result.syncRollbackStatus = `FAILED: ${rollbackMsg}`;
                        throw new Error(`Update apply failed. Original error: ${originalError}. Sync rollback failed: ${rollbackMsg}`);
                    }
                    throw new Error(`Update apply failed and sync rollback completed. Original error: ${originalError}`);
                }
                throw new Error(`Update apply failed. Error: ${originalError}`);
            }
            });
        }
    } finally {
        source.cleanup();
    }

    return result;
}

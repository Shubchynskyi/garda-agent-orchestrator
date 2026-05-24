import * as fs from 'node:fs';
import * as path from 'node:path';
import { PRIMARY_PACKAGE_NAME, resolveBundleName } from '../core/constants';
import { pathExists, readTextFile } from '../core/filesystem';
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
    type UpdateSentinelMetadata,
    writeSyncBackupMetadata,
    writeUpdateSentinel,
    validateTargetRoot,
    withLifecycleOperationLockAsync
} from './common';
import {
    parseNpmPackageSpec,
    type TrustValidationResult,
    validateNpmSourceTrust,
    validatePathSourceTrust
} from './update-trust';
import { classifyNpmDiagnostic, createLifecycleDiagnosticError } from './update-diagnostics';
import { assertNoRuntimeLocksBeforeUpdateApply } from './runtime-lock-preflight';
import { assertUpdateApplyAllowedInSwitchMode } from './update-off-mode';

export const DEFAULT_PACKAGE_NAME = PRIMARY_PACKAGE_NAME;
export const DEFAULT_UPDATE_TEMP_TTL_MS = 24 * 60 * 60 * 1000;

interface NpmInvocation {
    command: string;
    prefixArgs: string[];
}

interface ResolveInstalledPackageRootOptions {
    sourceReference?: string;
}

interface NpmViewResult {
    error?: Error;
    status: number | null;
    stdout?: string | Buffer | null;
    stderr?: string | Buffer | null;
}

interface NpmInstallResult {
    cancelled?: boolean;
    timedOut?: boolean;
    exitCode: number | null;
    stdout?: string | Buffer | null;
    stderr?: string | Buffer | null;
}

function buildNpmInstallFailureDiagnostic(
    installResult: NpmInstallResult,
    effectivePackageSpec: string,
    effectiveDiagnosticSource: string
): Error | null {
    if (installResult.cancelled) {
        return createLifecycleDiagnosticError({
            message: `npm install was cancelled for '${effectivePackageSpec}'.`,
            tool: 'npm',
            code: 'NPM_INSTALL_CANCELLED',
            sourceReference: effectiveDiagnosticSource,
            stderr: installResult.stderr,
            stdout: installResult.stdout
        });
    }

    if (installResult.timedOut) {
        return createLifecycleDiagnosticError({
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
        return createLifecycleDiagnosticError({
            message: `Failed to install update package '${effectivePackageSpec}'.`,
            tool: 'npm',
            code: classifyNpmDiagnostic(diagnosticText),
            sourceReference: effectiveDiagnosticSource,
            stderr: installResult.stderr,
            stdout: installResult.stdout
        });
    }

    return null;
}

interface ResolveNpmUpdateSourceSpecOptions {
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
    requestedPackageSpec?: string | null;
    exactPackageSpec?: string | null;
    resolvedPackageVersion?: string | null;
    resolvedPackageIntegrity?: string | null;
    lifecycleLockAlreadyHeld?: boolean;
}

interface CheckUpdateTestHooks {
    beforeSyncItemFaultInjector?: ((item: string, index: number) => void) | null;
    syncItemFaultInjector?: ((item: string, index: number) => void) | null;
    afterDeferredVersionSync?: (() => void) | null;
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
    npmViewRunner?: ((args: string[]) => NpmViewResult) | null;
    npmInstallRunner?: ((args: string[], options: SpawnStreamedOptions) => Promise<NpmInstallResult>) | null;
    installedPackageRootResolver?: ((
        tempInstallRoot: string,
        options?: ResolveInstalledPackageRootOptions
    ) => { packageName: string; packageRoot: string }) | null;
    updateRunner?: ((options: CheckUpdateRunnerOptions) => void) | null;
    _testHooks?: CheckUpdateTestHooks | null;
}

interface CheckUpdateResult {
    targetRoot: string;
    sourceType: string;
    sourceReference: string;
    packageSpec: string | null;
    requestedPackageSpec: string | null;
    exactPackageSpec: string | null;
    resolvedPackageVersion: string | null;
    resolvedPackageIntegrity: string | null;
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

const DEFERRED_VERSION_ITEM = 'VERSION';
const DEFERRED_LIVE_VERSION_PAYLOAD_ITEM = 'live/version.json';

type UpdateSentinelPhase = 'syncing' | 'lifecycle' | 'version_deferred' | 'complete';

interface PlannedBundleSyncItem {
    item: string;
    sourcePath: string;
    destinationPath: string;
    sourceIsDirectory: boolean;
    isNodeRuntimeDir: boolean;
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

    return options.allowExtraDestinationFiles || sourceFiles.length === destinationFiles.length;
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

function syncDeferredVersionFile(versionSourcePath: string, versionDestPath: string): void {
    const previousVersionContent = fs.existsSync(versionDestPath)
        ? fs.readFileSync(versionDestPath)
        : null;
    try {
        removePathRecursive(versionDestPath);
        fs.mkdirSync(path.dirname(versionDestPath), { recursive: true });
        fs.copyFileSync(versionSourcePath, versionDestPath);
    } catch (versionSyncError) {
        if (previousVersionContent !== null) {
            try {
                fs.mkdirSync(path.dirname(versionDestPath), { recursive: true });
                fs.writeFileSync(versionDestPath, previousVersionContent);
            } catch (_restoreErr) {
                // Best-effort restore; the outer apply catch handles rollback.
            }
        }
        throw versionSyncError;
    }
}

function collectExistingSourceSyncItems(sourceRoot: string): string[] {
    return BUNDLE_SYNC_ITEMS.filter((item) => fs.existsSync(path.join(sourceRoot, item)));
}

function collectRollbackSyncItems(sourceSyncItems: string[], deployedBundleRoot: string): string[] {
    const rollbackItems = [...sourceSyncItems];
    if (fs.existsSync(path.join(deployedBundleRoot, DEFERRED_LIVE_VERSION_PAYLOAD_ITEM)) &&
        !rollbackItems.includes(DEFERRED_LIVE_VERSION_PAYLOAD_ITEM)) {
        rollbackItems.push(DEFERRED_LIVE_VERSION_PAYLOAD_ITEM);
    }
    return rollbackItems;
}

function planBundleSyncItems(
    sourceRoot: string,
    deployedBundleRoot: string,
    sourceSyncItems: string[]
): PlannedBundleSyncItem[] {
    return sourceSyncItems
        .filter((item) => item !== DEFERRED_VERSION_ITEM)
        .map((item) => {
            const sourcePath = path.join(sourceRoot, item);
            const destinationPath = path.join(deployedBundleRoot, item);
            const sourceIsDirectory = fs.lstatSync(sourcePath).isDirectory();

            return {
                item,
                sourcePath,
                destinationPath,
                sourceIsDirectory,
                isNodeRuntimeDir: item.toLowerCase() === 'src'
            };
        });
}

function buildUpdateSentinelMetadata(
    source: AcquiredUpdateSource,
    currentVersion: string,
    latestVersion: string,
    syncBackupRoot: string,
    syncBackupMetadataPath: string,
    plannedSyncItems: string[]
): UpdateSentinelMetadata {
    return {
        startedAt: new Date().toISOString(),
        fromVersion: currentVersion,
        toVersion: latestVersion,
        sourceType: source.sourceType,
        sourceReference: source.sourceReference,
        packageSpec: source.packageSpec,
        requestedPackageSpec: source.requestedPackageSpec,
        exactPackageSpec: source.exactPackageSpec,
        resolvedPackageVersion: source.resolvedPackageVersion,
        resolvedPackageIntegrity: source.resolvedPackageIntegrity,
        syncBackupRoot,
        syncBackupMetadataPath,
        plannedSyncItems
    };
}

function writeUpdateSentinelPhase(
    deployedBundleRoot: string,
    metadata: UpdateSentinelMetadata,
    phase: UpdateSentinelPhase
): void {
    writeUpdateSentinel(
        deployedBundleRoot,
        {
            ...metadata,
            phase
        }
    );
}

function syncPlannedBundleItem(plan: PlannedBundleSyncItem, runningScriptPath: string | null): void {
    if (plan.sourceIsDirectory) {
        if (plan.isNodeRuntimeDir) {
            if (!fs.existsSync(plan.destinationPath) || !fs.lstatSync(plan.destinationPath).isDirectory()) {
                removePathRecursive(plan.destinationPath);
                fs.mkdirSync(plan.destinationPath, { recursive: true });
            }
            const skipPaths = runningScriptPath ? [path.resolve(runningScriptPath)] : [];
            copyDirectoryContentMerge(plan.sourcePath, plan.destinationPath, skipPaths);
        } else {
            removePathRecursive(plan.destinationPath);
            copyPathRecursive(plan.sourcePath, plan.destinationPath);
        }
        return;
    }

    removePathRecursive(plan.destinationPath);
    fs.mkdirSync(path.dirname(plan.destinationPath), { recursive: true });
    fs.copyFileSync(plan.sourcePath, plan.destinationPath);
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

function isExactNpmVersion(version: string | null): boolean {
    return typeof version === 'string'
        && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(version.trim());
}

function selectNpmViewRecord(parsed: unknown, sourceReference: string, stdout: string): Record<string, unknown> {
    if (Array.isArray(parsed)) {
        const records = parsed
            .map((entry) => toObjectRecord(entry))
            .filter((entry): entry is Record<string, unknown> => entry !== null);
        if (records.length === 0) {
            throw createLifecycleDiagnosticError({
                message: `npm metadata for update package '${sourceReference}' did not contain any usable version records.`,
                tool: 'npm',
                code: 'NPM_METADATA_INVALID',
                sourceReference,
                stdout
            });
        }

        const sorted = records
            .map((record) => ({
                record,
                version: String(record.version || '').trim()
            }))
            .sort((left, right) => compareVersionStrings(left.version, right.version));
        return sorted[sorted.length - 1].record;
    }

    const record = toObjectRecord(parsed);
    if (!record) {
        throw createLifecycleDiagnosticError({
            message: `npm metadata for update package '${sourceReference}' was ambiguous.`,
            tool: 'npm',
            code: 'NPM_METADATA_INVALID',
            sourceReference,
            stdout
        });
    }

    return record;
}

function parseNpmViewJson(stdout: string, sourceReference: string): { version: string; integrity: string } {
    let parsed: unknown;
    try {
        parsed = JSON.parse(stdout);
    } catch (_error) {
        throw createLifecycleDiagnosticError({
            message: `Failed to parse npm metadata for update package '${sourceReference}'.`,
            tool: 'npm',
            code: 'NPM_METADATA_INVALID',
            sourceReference,
            stdout
        });
    }

    const record = selectNpmViewRecord(parsed, sourceReference, stdout);

    const version = String(record.version || '').trim();
    const integrity = String(record['dist.integrity'] || '').trim();
    if (!version || !isExactNpmVersion(version)) {
        throw createLifecycleDiagnosticError({
            message: `npm metadata did not resolve an exact version for update package '${sourceReference}'.`,
            tool: 'npm',
            code: 'NPM_METADATA_INVALID',
            sourceReference,
            stdout
        });
    }

    if (!integrity) {
        throw createLifecycleDiagnosticError({
            message: `npm metadata did not include dist.integrity for update package '${sourceReference}'.`,
            tool: 'npm',
            code: 'NPM_METADATA_INVALID',
            sourceReference,
            stdout
        });
    }

    return { version, integrity };
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

export function resolveNpmUpdateSourceSpec(
    requestedSpec: string,
    options: ResolveNpmUpdateSourceSpecOptions = {}
): ResolvedNpmUpdateSource {
    const requested = String(requestedSpec || '').trim();
    const parsed = parseNpmPackageSpec(requested);
    if (!parsed || !parsed.name) {
        return {
            requestedSpec: requested,
            exactSpec: requested,
            packageName: null,
            version: null,
            integrity: null,
            resolutionMode: 'direct'
        };
    }

    const exactRequested = isExactNpmVersion(parsed.version);
    const lookupSpec = parsed.version ? `${parsed.name}@${parsed.version}` : parsed.name;
    const sourceReference = String(options.sourceReference || lookupSpec);
    const viewRunner = options.viewRunner || ((args: string[]) => runNpmSync(args));
    const viewResult = viewRunner(['view', lookupSpec, 'version', 'dist.integrity', '--json']);
    const detailText = viewResult.error ? getErrorMessage(viewResult.error) : '';
    if (viewResult.error || viewResult.status !== 0) {
        throw createLifecycleDiagnosticError({
            message: `Failed to resolve update package '${lookupSpec}' to an exact npm version.`,
            tool: 'npm',
            code: 'NPM_METADATA_UNAVAILABLE',
            sourceReference,
            stderr: viewResult.stderr,
            stdout: viewResult.stdout,
            detailText
        });
    }

    const stdout = String(viewResult.stdout || '').trim();
    if (!stdout) {
        throw createLifecycleDiagnosticError({
            message: `npm metadata was empty for update package '${lookupSpec}'.`,
            tool: 'npm',
            code: 'NPM_METADATA_EMPTY',
            sourceReference
        });
    }

    const metadata = parseNpmViewJson(stdout, sourceReference);
    if (exactRequested && parsed.version !== metadata.version) {
        throw createLifecycleDiagnosticError({
            message: `npm metadata version '${metadata.version}' did not match requested update package version '${parsed.version}' for '${lookupSpec}'.`,
            tool: 'npm',
            code: 'NPM_METADATA_INVALID',
            sourceReference,
            stdout
        });
    }

    return {
        requestedSpec: requested,
        exactSpec: `${parsed.name}@${metadata.version}`,
        packageName: parsed.name,
        version: metadata.version,
        integrity: metadata.integrity,
        resolutionMode: exactRequested ? 'explicit_exact' : 'resolved'
    };
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

export function getUpdateTempRoot(runtimeRoot: string): string {
    return path.join(runtimeRoot, 'update-temp');
}

export function cleanupOldUpdateTempRoots(
    runtimeRoot: string,
    ttlMs: number = DEFAULT_UPDATE_TEMP_TTL_MS,
    nowMs: number = Date.now()
): string[] {
    const updateTempRoot = getUpdateTempRoot(runtimeRoot);
    if (!fs.existsSync(updateTempRoot)) {
        return [];
    }

    const removed: string[] = [];
    for (const entry of fs.readdirSync(updateTempRoot, { withFileTypes: true })) {
        if (!entry.isDirectory() || !entry.name.startsWith('npm-')) {
            continue;
        }

        const candidatePath = path.join(updateTempRoot, entry.name);
        const stats = fs.statSync(candidatePath);
        if (nowMs - stats.mtimeMs <= ttlMs) {
            continue;
        }

        removePathRecursive(candidatePath);
        removed.push(candidatePath);
    }

    return removed;
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
        prevalidatedPathTrustResult = null,
        npmViewRunner = null,
        npmInstallRunner = null,
        installedPackageRootResolver = null
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
            requestedPackageSpec: null,
            exactPackageSpec: null,
            resolvedPackageVersion: null,
            resolvedPackageIntegrity: null,
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
    const resolvedPackageSpec = resolveNpmUpdateSourceSpec(effectivePackageSpec, {
        sourceReference: effectiveDiagnosticSource,
        viewRunner: npmViewRunner
    });
    const installPackageSpec = resolvedPackageSpec.exactSpec || effectivePackageSpec;

    const runtimeRoot = path.join(deployedBundleRoot, 'runtime');
    cleanupOldUpdateTempRoots(runtimeRoot);
    const updateTempRoot = getUpdateTempRoot(runtimeRoot);
    fs.mkdirSync(updateTempRoot, { recursive: true });
    const tempInstallRoot = fs.mkdtempSync(path.join(updateTempRoot, 'npm-'));

    let acquiredSource: AcquiredUpdateSource | null = null;
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
            installPackageSpec
        ];
        const installOptions = {
            signal: signal ?? undefined,
            onStderr: onProgress ?? undefined
        };
        const installResult = npmInstallRunner
            ? await npmInstallRunner(installArgs, installOptions)
            : await runNpmStreamed(installArgs, installOptions);

        const failedInstallDiagnostic = buildNpmInstallFailureDiagnostic(
            installResult,
            effectivePackageSpec,
            effectiveDiagnosticSource
        );
        if (failedInstallDiagnostic) {
            throw failedInstallDiagnostic;
        }

        const installed = installedPackageRootResolver
            ? installedPackageRootResolver(tempInstallRoot, { sourceReference: effectiveDiagnosticSource })
            : resolveInstalledPackageRoot(tempInstallRoot, { sourceReference: effectiveDiagnosticSource });
        acquiredSource = {
            sourceType: 'npm',
            sourceReference: installPackageSpec,
            diagnosticSourceReference: effectiveDiagnosticSource,
            packageSpec: installPackageSpec,
            requestedPackageSpec: resolvedPackageSpec.requestedSpec,
            exactPackageSpec: resolvedPackageSpec.exactSpec,
            resolvedPackageVersion: resolvedPackageSpec.version,
            resolvedPackageIntegrity: resolvedPackageSpec.integrity,
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
        return acquiredSource;
    } finally {
        if (!acquiredSource) {
            removePathRecursive(tempInstallRoot);
        }
    }
}

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

            if (!dryRun) {
                assertNoRuntimeLocksBeforeUpdateApply(deployedBundleRoot);
            }

            const sourceSyncItems = collectExistingSourceSyncItems(source.sourceRoot);
            const plannedSyncItems = planBundleSyncItems(source.sourceRoot, deployedBundleRoot, sourceSyncItems);
            const plannedSyncItemNames = plannedSyncItems.map((plan) => plan.item);
            const rollbackSyncItemNames = collectRollbackSyncItems(sourceSyncItems, deployedBundleRoot);
            const syncPreexistingMap = Object.fromEntries(
                rollbackSyncItemNames.map((item) => [item, fs.existsSync(path.join(deployedBundleRoot, item))])
            ) as Record<string, boolean>;
            let syncPreparationCompleted = false;
            let destructiveSyncStarted = false;

            try {
                result.syncItemsDetected += sourceSyncItems.length;

                if (dryRun) {
                    result.syncedItems.push(...sourceSyncItems);
                    result.checkUpdateResult = 'DRY_RUN_UPDATE_AVAILABLE';
                } else {
                    for (const item of rollbackSyncItemNames) {
                        if (!syncPreexistingMap[item]) {
                            continue;
                        }
                        const destinationPath = path.join(deployedBundleRoot, item);
                        const backupPath = path.join(syncBackupRoot, item);
                        fs.mkdirSync(path.dirname(backupPath), { recursive: true });
                        copyPathRecursive(destinationPath, backupPath);
                        result.syncItemsBackedUp++;
                        result.syncBackupRoot = syncBackupRoot;
                    }

                    const syncMetadataPath = writeSyncBackupMetadata(syncBackupRoot, {
                        createdAt: new Date().toISOString(),
                        sourceType: source.sourceType,
                        sourceReference: source.sourceReference,
                        packageSpec: source.packageSpec,
                        requestedPackageSpec: source.requestedPackageSpec,
                        exactPackageSpec: source.exactPackageSpec,
                        resolvedPackageVersion: source.resolvedPackageVersion,
                        resolvedPackageIntegrity: source.resolvedPackageIntegrity,
                        plannedSyncItems: plannedSyncItemNames,
                        preexistingMap: syncPreexistingMap
                    });
                    result.syncBackupRoot = syncBackupRoot;
                    result.syncBackupMetadataPath = syncMetadataPath;
                    const updateSentinelMetadata = buildUpdateSentinelMetadata(
                        source,
                        currentVersion,
                        latestVersion,
                        syncBackupRoot,
                        syncMetadataPath,
                        plannedSyncItemNames
                    );

                    writeUpdateSentinelPhase(
                        deployedBundleRoot,
                        updateSentinelMetadata,
                        'syncing'
                    );

                    syncPreparationCompleted = true;
                    destructiveSyncStarted = plannedSyncItems.length > 0;
                    for (let index = 0; index < plannedSyncItems.length; index++) {
                        const plan = plannedSyncItems[index];
                        _testHooks?.beforeSyncItemFaultInjector?.(plan.item, index);
                        syncPlannedBundleItem(plan, runningScriptPath);
                        result.syncItemsUpdated++;
                        result.syncedItems.push(plan.item);
                        _testHooks?.syncItemFaultInjector?.(plan.item, index);
                    }

                    writeUpdateSentinelPhase(
                        deployedBundleRoot,
                        updateSentinelMetadata,
                        'lifecycle'
                    );

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
                            requestedPackageSpec: result.requestedPackageSpec,
                            exactPackageSpec: result.exactPackageSpec,
                            resolvedPackageVersion: result.resolvedPackageVersion,
                            resolvedPackageIntegrity: result.resolvedPackageIntegrity,
                            lifecycleLockAlreadyHeld: true
                        });
                    }

                    writeUpdateSentinelPhase(
                        deployedBundleRoot,
                        updateSentinelMetadata,
                        'version_deferred'
                    );

                    // Sync deferred VERSION only after lifecycle has completed successfully.
                    // This ensures the workspace version does not advance until the full
                    // lifecycle (materialization, verify, etc.) is finished.
                    const versionSourcePath = path.join(source.sourceRoot, DEFERRED_VERSION_ITEM);
                    if (fs.existsSync(versionSourcePath)) {
                        const versionDestPath = path.join(deployedBundleRoot, DEFERRED_VERSION_ITEM);
                        destructiveSyncStarted = true;
                        syncDeferredVersionFile(versionSourcePath, versionDestPath);
                        result.syncItemsUpdated++;
                        result.syncedItems.push(DEFERRED_VERSION_ITEM);
                        syncDeferredLiveVersionPayload(deployedBundleRoot, readTextFile(versionDestPath).trim());
                        _testHooks?.afterDeferredVersionSync?.();
                    }

                    writeUpdateSentinelPhase(
                        deployedBundleRoot,
                        updateSentinelMetadata,
                        'complete'
                    );
                    removeUpdateSentinel(deployedBundleRoot);

                    result.updateApplied = true;
                    result.checkUpdateResult = 'UPDATED';
                    if (Object.keys(syncPreexistingMap).length > 0 && result.syncRollbackStatus === 'NOT_NEEDED') {
                        result.syncRollbackStatus = 'NOT_TRIGGERED';
                    }
                }
            } catch (applyError) {
                const originalError = getErrorMessage(applyError);
                if (!dryRun && syncPreparationCompleted && destructiveSyncStarted &&
                    Object.keys(syncPreexistingMap).length > 0) {
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

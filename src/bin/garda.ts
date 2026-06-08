#!/usr/bin/env node

import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface CliMainModule {
    runCliMainWithHandling: (argv?: string[], packageRoot?: string) => Promise<void>;
}

const PRODUCT_NAME = 'Garda Agent Orchestrator';
const DEFAULT_BUNDLE_NAME = 'garda-agent-orchestrator';
const PRIMARY_CLI_ENTRYPOINT = path.join('bin', 'garda.js');
const DELEGATION_TIMEOUT_ENV = 'GARDA_LAUNCHER_DELEGATION_TIMEOUT_MS';
const DELEGATION_TIMEOUT_KILL_GRACE_MS = 1000;
const RUNTIME_LOAD_LOCK_TIMEOUT_ENV = 'GARDA_LAUNCHER_RUNTIME_LOCK_TIMEOUT_MS';
const RUNTIME_LOAD_LOCK_POLL_MS = 50;
const RUNTIME_LOAD_RETRY_DELAY_MS = 50;
const RUNTIME_LOAD_MAX_ATTEMPTS = 3;
const RECOGNIZED_PACKAGE_NAMES = new Set([
    'garda-agent-orchestrator'
]);
const SOURCE_CHECKOUT_PROVENANCE_PATHS = Object.freeze([
    path.join('src', 'bin', 'garda.ts'),
    path.join('tests', 'node'),
    path.join('scripts', 'node-foundation')
]);
const DEPLOYED_BUNDLE_PROVENANCE_PATHS = Object.freeze([
    'MANIFEST.md',
    path.join('live', 'version.json'),
    path.join('live', 'docs', 'agent-rules', '00-core.md'),
    path.join('live', 'config', 'profiles.json'),
    path.join('live', 'config', 'review-capabilities.json')
]);

export type DelegationRuntimeKind = 'source_checkout' | 'deployed_bundle' | 'packaged_npm' | 'unknown';
export type DelegationTrustLevel = 'trusted_self_hosted' | 'trusted_local_workspace' | 'packaged_runtime' | 'unknown';
export type DelegationDecision = 'not_required' | 'allowed' | 'blocked';
export type DelegationTargetReason =
    | 'target_root_source_checkout'
    | 'target_root_deployed_bundle'
    | 'cwd_source_checkout'
    | 'cwd_deployed_bundle';

export interface DelegatedRuntimeEvidence {
    cli_path: string;
    root: string;
    runtime_kind: Extract<DelegationRuntimeKind, 'source_checkout' | 'deployed_bundle'>;
    reason: DelegationTargetReason;
    package_name: string;
    package_version: string | null;
    path_containment: 'validated';
}

export interface CurrentRuntimeEvidence {
    package_root: string;
    runtime_kind: DelegationRuntimeKind;
    package_installed_under_node_modules: boolean;
    recognized_package_name: boolean;
    package_name: string | null;
    package_version: string | null;
}

export interface DelegationTrustDecision {
    decision: DelegationDecision;
    trust_level: DelegationTrustLevel;
    reason: string;
}

export interface DelegationTrustEvidence {
    current_runtime: CurrentRuntimeEvidence;
    delegated_runtime: DelegatedRuntimeEvidence | null;
    implementation_delegation: DelegationTrustDecision;
    mandatory_review_delegation: DelegationTrustDecision & {
        requires_provider_launch_attestation: boolean;
    };
}

function buildMandatoryReviewDelegation(
    decision: DelegationDecision,
    trustLevel: DelegationTrustLevel,
    reason: string
): DelegationTrustEvidence['mandatory_review_delegation'] {
    return {
        decision,
        trust_level: trustLevel,
        reason,
        requires_provider_launch_attestation: true
    };
}

function resolveBundleName(): string {
    const bundleName = process.env.GARDA_BUNDLE_NAME;
    return bundleName === undefined
        ? DEFAULT_BUNDLE_NAME
        : validateBundleName(bundleName, 'GARDA_BUNDLE_NAME');
}

function validateBundleName(bundleName: string, source: string): string {
    if (
        bundleName === ''
        || bundleName.trim() !== bundleName
        || bundleName === '.'
        || bundleName === '..'
        || bundleName.startsWith('-')
        || path.isAbsolute(bundleName)
        || bundleName.includes('/')
        || bundleName.includes('\\')
    ) {
        throw new Error(
            `${PRODUCT_NAME} ${source} must be a deployed bundle directory name, not a path: ` +
            `${JSON.stringify(bundleName)}. Pass a direct child directory name such as ` +
            `"${DEFAULT_BUNDLE_NAME}".`
        );
    }
    return bundleName;
}

function isRecognizedPackageName(value: unknown): boolean {
    const normalized = String(value || '').trim().toLowerCase();
    return normalized !== '' && RECOGNIZED_PACKAGE_NAMES.has(normalized);
}

function normalizePathForComparison(value: string): string {
    const resolved = path.resolve(value);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isPathInsideOrEqual(parentPath: string, childPath: string): boolean {
    const normalizedParent = normalizePathForComparison(parentPath);
    const normalizedChild = normalizePathForComparison(childPath);
    const relative = path.relative(normalizedParent, normalizedChild);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function tryRealpath(value: string): string | null {
    try {
        return fs.realpathSync.native(value);
    } catch {
        return null;
    }
}

function rootHasAllPaths(rootPath: string, relativePaths: readonly string[]): boolean {
    return relativePaths.every((relativePath) => fs.existsSync(path.join(rootPath, relativePath)));
}

function resolvePreferredCliPath(candidateRoot: string): string | null {
    const candidate = path.join(candidateRoot, PRIMARY_CLI_ENTRYPOINT);
    return fs.existsSync(candidate) ? candidate : null;
}

export function findPackageRoot(startDir: string): string {
    let current = path.resolve(startDir);

    while (true) {
        if (
            fs.existsSync(path.join(current, 'package.json'))
            && fs.existsSync(path.join(current, 'VERSION'))
        ) {
            return current;
        }

        const parent = path.dirname(current);
        if (parent === current) {
            throw new Error(`Cannot resolve package root from ${startDir}`);
        }
        current = parent;
    }
}

function hasRuntimeRoot(runtimeRoot: string): boolean {
    return fs.existsSync(path.join(runtimeRoot, 'index.js'));
}

function isRecoverableLoadError(error: unknown): boolean {
    if (!error || typeof error !== 'object') {
        return false;
    }
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'MODULE_NOT_FOUND' || code === 'ENOENT';
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function sleepSync(milliseconds: number): void {
    if (!milliseconds || milliseconds <= 0) {
        return;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function getRuntimeBuildLockPath(runtimeRoot: string): string {
    return `${path.dirname(runtimeRoot)}.lock`;
}

function computeDeadline(timeoutMs: number): number {
    return Date.now() + timeoutMs;
}

function getRemainingMilliseconds(deadline: number): number {
    return Math.max(0, deadline - Date.now());
}

function waitForRuntimeBuildLock(runtimeRoot: string, deadline: number): boolean {
    const lockPath = getRuntimeBuildLockPath(runtimeRoot);
    if (!fs.existsSync(lockPath)) {
        return false;
    }

    while (fs.existsSync(lockPath)) {
        const remainingMs = getRemainingMilliseconds(deadline);
        if (remainingMs <= 0) {
            throw new Error(
                `Timed out waiting for ${PRODUCT_NAME} runtime build lock to clear: ${lockPath}`
            );
        }
        sleepSync(Math.min(RUNTIME_LOAD_LOCK_POLL_MS, remainingMs));
    }

    return true;
}

function clearRuntimeRequireCache(runtimeRoot: string): void {
    const normalizedRoot = path.resolve(runtimeRoot) + path.sep;
    for (const cachedPath of Object.keys(require.cache)) {
        if (path.resolve(cachedPath).startsWith(normalizedRoot)) {
            delete require.cache[cachedPath];
        }
    }
}

export function getRuntimeCandidates(packageRoot: string): string[] {
    const devBuildRuntimeRoot = path.join(packageRoot, '.node-build', 'src');
    const publishRuntimeRoot = path.join(packageRoot, 'dist', 'src');
    const candidates: string[] = [];

    if (hasRuntimeRoot(publishRuntimeRoot)) {
        candidates.push(publishRuntimeRoot);
    }

    if (looksLikeSourceCheckout(packageRoot) && hasRuntimeRoot(devBuildRuntimeRoot)) {
        candidates.push(devBuildRuntimeRoot);
    }

    return candidates;
}

export function loadCliMainModule(packageRoot: string): CliMainModule {
    const runtimeCandidates = getRuntimeCandidates(packageRoot);
    if (runtimeCandidates.length === 0) {
        console.error(
            `${PRODUCT_NAME} runtime build output not found.\n`
            + 'Run "npm run build" to compile TypeScript sources before execution.'
        );
        process.exit(1);
    }

    let lastError: unknown = null;

    for (let index = 0; index < runtimeCandidates.length; index += 1) {
        const runtimeRoot = runtimeCandidates[index];
        const runtimeLoadDeadline = computeDeadline(
            parsePositiveInteger(process.env[RUNTIME_LOAD_LOCK_TIMEOUT_ENV], 120_000)
        );
        for (let attempt = 0; attempt < RUNTIME_LOAD_MAX_ATTEMPTS; attempt += 1) {
            waitForRuntimeBuildLock(runtimeRoot, runtimeLoadDeadline);
            try {
                return require(path.join(runtimeRoot, 'cli', 'main.js')) as CliMainModule;
            } catch (error: unknown) {
                lastError = error;
                const recoverable = isRecoverableLoadError(error);
                const hasFallback = index < runtimeCandidates.length - 1;
                if (!recoverable) {
                    throw error;
                }
                clearRuntimeRequireCache(runtimeRoot);
                if (attempt < RUNTIME_LOAD_MAX_ATTEMPTS - 1) {
                    waitForRuntimeBuildLock(runtimeRoot, runtimeLoadDeadline);
                    const remainingMs = getRemainingMilliseconds(runtimeLoadDeadline);
                    if (remainingMs <= 0) {
                        if (hasFallback) {
                            break;
                        }
                        throw error;
                    }
                    sleepSync(Math.min(RUNTIME_LOAD_RETRY_DELAY_MS, remainingMs));
                    continue;
                }
                if (!hasFallback) {
                    throw error;
                }
                break;
            }
        }
    }

    throw lastError;
}

function isPackageInstalledUnderNodeModules(packageRoot: string): boolean {
    return path.resolve(packageRoot).split(path.sep).includes('node_modules');
}

function readPackageMetadata(packageRoot: string): { name: string | null; version: string | null } {
    const packageJsonPath = path.join(packageRoot, 'package.json');
    if (!fs.existsSync(packageJsonPath)) {
        return { name: null, version: null };
    }
    try {
        const parsed = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as { name?: unknown; version?: unknown };
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return { name: null, version: null };
        }
        return {
            name: typeof parsed.name === 'string' && parsed.name.trim() ? parsed.name : null,
            version: typeof parsed.version === 'string' && parsed.version.trim() ? parsed.version : null
        };
    } catch (_error) {
        return { name: null, version: null };
    }
}

function isGardaPackageRoot(candidateRoot: string): boolean {
    const packageMetadata = readPackageMetadata(candidateRoot);
    const candidateCliPath = resolvePreferredCliPath(candidateRoot);
    const realCandidateRoot = tryRealpath(candidateRoot);
    const realCandidateCliPath = candidateCliPath ? tryRealpath(candidateCliPath) : null;
    return isRecognizedPackageName(packageMetadata.name)
        && fs.existsSync(path.join(candidateRoot, 'VERSION'))
        && candidateCliPath !== null
        && realCandidateRoot !== null
        && realCandidateCliPath !== null
        && isPathInsideOrEqual(realCandidateRoot, realCandidateCliPath);
}

function findSourceCheckoutRoot(startDir: string): string | null {
    let current = path.resolve(startDir);

    while (true) {
        if (isGardaPackageRoot(current) && looksLikeSourceCheckout(current)) {
            return current;
        }

        const parent = path.dirname(current);
        if (parent === current) {
            return null;
        }
        current = parent;
    }
}

function findDeployedBundleRoot(startDir: string): string | null {
    const effectiveName = resolveBundleName();
    const allowFallback = process.env.GARDA_BUNDLE_NAME === undefined;
    let current = path.resolve(startDir);

    while (true) {
        if (isGardaPackageRoot(current) && looksLikeDeployedBundleRoot(current)) {
            return current;
        }

        const bundleRoot = path.join(current, effectiveName);
        if (isGardaPackageRoot(bundleRoot) && looksLikeDeployedBundleRoot(bundleRoot)) {
            return bundleRoot;
        }
        const inferredBundleRoot = findDeployedBundleRootInWorkspace(current, effectiveName, allowFallback);
        if (inferredBundleRoot) {
            return inferredBundleRoot;
        }

        const parent = path.dirname(current);
        if (parent === current) {
            return null;
        }
        current = parent;
    }
}

function findDeployedBundleRootInWorkspace(workspaceRoot: string, preferredName: string, allowFallback: boolean): string | null {
    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(workspaceRoot, { withFileTypes: true });
    } catch {
        return null;
    }

    const fallbackMatches: string[] = [];
    for (const entry of entries) {
        if (!entry.isDirectory()) {
            continue;
        }
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) {
            continue;
        }
        const candidateRoot = path.join(workspaceRoot, entry.name);
        if (!isGardaPackageRoot(candidateRoot) || !looksLikeDeployedBundleRoot(candidateRoot)) {
            continue;
        }
        if (entry.name === preferredName) {
            return candidateRoot;
        }
        fallbackMatches.push(candidateRoot);
    }

    if (fallbackMatches.length === 0) {
        return null;
    }
    const candidateNames = fallbackMatches
        .map((candidateRoot) => path.basename(candidateRoot))
        .sort((left, right) => left.localeCompare(right));
    if (!allowFallback) {
        throw new Error(
            `${PRODUCT_NAME} deployed bundle '${preferredName}' was not found in ${workspaceRoot}. ` +
            `Detected candidates: ${candidateNames.join(', ')}. ` +
            'Use an existing direct child deployed bundle name.'
        );
    }
    if (fallbackMatches.length === 1) {
        const fallbackRoot = fallbackMatches[0];
        const fallbackName = path.basename(fallbackRoot);
        console.error(
            `${PRODUCT_NAME} deployed bundle '${preferredName}' was not found in ${workspaceRoot}; ` +
            `using the single detected fallback candidate '${fallbackName}'. ` +
            'Pass --bundle-name explicitly to select a deployed bundle by name.'
        );
        return fallbackRoot;
    }

    throw new Error(
        `Multiple ${PRODUCT_NAME} deployed bundle candidates found in ${workspaceRoot}: ` +
        `${candidateNames.join(', ')}. Pass --bundle-name explicitly to select one.`
    );
}

function extractTargetRootArg(argv: string[], cwd: string): string | null {
    for (let index = 0; index < argv.length; index += 1) {
        const token = argv[index];
        if (token === '--target-root' && index + 1 < argv.length) {
            return path.resolve(cwd, argv[index + 1]);
        }
        if (token.startsWith('--target-root=')) {
            return path.resolve(cwd, token.slice('--target-root='.length));
        }
    }
    return null;
}

export function resolveDelegationStartDirs(argv: string[], cwd: string): { startDir: string; source: 'target_root' | 'cwd' }[] {
    const candidates = [
        { startDir: extractTargetRootArg(argv, cwd), source: 'target_root' as const },
        { startDir: cwd, source: 'cwd' as const }
    ]
        .filter((value): value is { startDir: string; source: 'target_root' | 'cwd' } => Boolean(value.startDir))
        .map((value) => ({ ...value, startDir: path.resolve(value.startDir) }));
    const seen = new Set<string>();
    return candidates.filter((candidate) => {
        const key = candidate.startDir;
        if (seen.has(key)) {
            return false;
        }
        seen.add(key);
        return true;
    });
}

export function buildDelegationTrustEvidence(
    currentRuntime: CurrentRuntimeEvidence,
    delegatedRuntime: DelegatedRuntimeEvidence | null
): DelegationTrustEvidence {
    const installedUnderNodeModules = currentRuntime.package_installed_under_node_modules;

    if (!currentRuntime.recognized_package_name) {
        return {
            current_runtime: currentRuntime,
            delegated_runtime: null,
            implementation_delegation: {
                decision: installedUnderNodeModules ? 'blocked' : 'not_required',
                trust_level: 'unknown',
                reason: 'Current runtime package name is not recognized; it cannot be trusted as a Garda runtime.'
            },
            mandatory_review_delegation: buildMandatoryReviewDelegation(
                'blocked',
                'unknown',
                'Mandatory reviewer delegation cannot rely on an unrecognized current runtime identity.'
            )
        };
    }

    if (currentRuntime.runtime_kind === 'unknown') {
        return {
            current_runtime: currentRuntime,
            delegated_runtime: null,
            implementation_delegation: {
                decision: 'blocked',
                trust_level: 'unknown',
                reason: 'Current runtime kind is unknown; workspace delegation must fail closed.'
            },
            mandatory_review_delegation: buildMandatoryReviewDelegation(
                'blocked',
                'unknown',
                'Mandatory reviewer delegation cannot rely on an unknown current runtime kind.'
            )
        };
    }

    if (!installedUnderNodeModules && currentRuntime.runtime_kind === 'source_checkout') {
        return {
            current_runtime: currentRuntime,
            delegated_runtime: null,
            implementation_delegation: {
                decision: 'not_required',
                trust_level: 'trusted_self_hosted',
                reason: 'Current runtime is the self-hosted source checkout; implementation delegation to another workspace runtime is not required.'
            },
            mandatory_review_delegation: buildMandatoryReviewDelegation(
                'allowed',
                'trusted_self_hosted',
                'Self-hosted source checkout is trusted, but reviewer launch still requires provider-native delegated reviewer attestation.'
            )
        };
    }

    if (delegatedRuntime) {
        return {
            current_runtime: currentRuntime,
            delegated_runtime: delegatedRuntime,
            implementation_delegation: {
                decision: 'allowed',
                trust_level: 'trusted_local_workspace',
                reason: `Delegated ${delegatedRuntime.runtime_kind} runtime was resolved from ${delegatedRuntime.reason}.`
            },
            mandatory_review_delegation: buildMandatoryReviewDelegation(
                'allowed',
                'trusted_local_workspace',
                'Delegated workspace runtime is recognized; mandatory reviews still require provider-native delegated reviewer attestation.'
            )
        };
    }

    return {
        current_runtime: currentRuntime,
        delegated_runtime: null,
        implementation_delegation: {
            decision: installedUnderNodeModules ? 'blocked' : 'not_required',
            trust_level: installedUnderNodeModules ? 'unknown' : 'packaged_runtime',
            reason: installedUnderNodeModules
                ? 'Installed packaged runtime could not resolve a trusted local source checkout or deployed bundle target for workspace delegation.'
                : 'Current runtime is not installed under node_modules; launcher delegation is not required.'
        },
        mandatory_review_delegation: buildMandatoryReviewDelegation(
            installedUnderNodeModules ? 'blocked' : 'allowed',
            installedUnderNodeModules ? 'unknown' : 'packaged_runtime',
            installedUnderNodeModules
                ? 'Mandatory reviewer delegation cannot rely on an unknown workspace runtime target.'
                : 'Packaged runtime may continue only with provider-native delegated reviewer attestation.'
        )
    };
}

function resolveCliPathIfExternal(candidateRoot: string | null, currentScriptPath: string): string | null {
    if (!candidateRoot) {
        return null;
    }

    const candidateCli = resolvePreferredCliPath(candidateRoot);
    if (!candidateCli) {
        return null;
    }

    const currentRealPath = fs.realpathSync.native(currentScriptPath);
    const candidateRealPath = fs.realpathSync.native(candidateCli);
    const candidateRootRealPath = fs.realpathSync.native(candidateRoot);
    if (!isPathInsideOrEqual(candidateRootRealPath, candidateRealPath)) {
        return null;
    }
    if (candidateRealPath === currentRealPath) {
        return null;
    }

    return candidateCli;
}

function hasLauncherOwnershipEvidence(packageRoot: string, currentScriptPath: string): boolean {
    try {
        const expectedCliPath = resolvePreferredCliPath(path.resolve(packageRoot));
        if (!expectedCliPath) {
            return false;
        }
        return fs.realpathSync.native(expectedCliPath) === fs.realpathSync.native(currentScriptPath);
    } catch {
        return false;
    }
}

function looksLikeDeployedBundleRoot(packageRoot: string): boolean {
    const normalizedPackageRoot = path.resolve(packageRoot);
    return !isPackageInstalledUnderNodeModules(normalizedPackageRoot)
        && !looksLikeSourceCheckout(normalizedPackageRoot)
        && rootHasAllPaths(normalizedPackageRoot, DEPLOYED_BUNDLE_PROVENANCE_PATHS);
}

function resolveCurrentRuntimeKind(packageRoot: string, currentScriptPath: string): DelegationRuntimeKind {
    if (!hasLauncherOwnershipEvidence(packageRoot, currentScriptPath)) {
        return 'unknown';
    }
    if (isPackageInstalledUnderNodeModules(packageRoot)) {
        return 'packaged_npm';
    }
    if (looksLikeSourceCheckout(packageRoot)) {
        return 'source_checkout';
    }
    if (looksLikeDeployedBundleRoot(packageRoot)) {
        return 'deployed_bundle';
    }
    return 'unknown';
}

function buildDelegationTargetReason(
    source: 'target_root' | 'cwd',
    runtimeKind: Extract<DelegationRuntimeKind, 'source_checkout' | 'deployed_bundle'>
): DelegationTargetReason {
    if (source === 'target_root' && runtimeKind === 'source_checkout') {
        return 'target_root_source_checkout';
    }
    if (source === 'target_root' && runtimeKind === 'deployed_bundle') {
        return 'target_root_deployed_bundle';
    }
    if (runtimeKind === 'source_checkout') {
        return 'cwd_source_checkout';
    }
    return 'cwd_deployed_bundle';
}

function resolveDelegatedRuntimeEvidence(
    argv: string[],
    cwd: string,
    currentScriptPath: string,
    packageRoot: string
): DelegatedRuntimeEvidence | null {
    if (!isPackageInstalledUnderNodeModules(packageRoot)) {
        return null;
    }

    for (const candidate of resolveDelegationStartDirs(argv, cwd)) {
        const sourceRoot = findSourceCheckoutRoot(candidate.startDir);
        const sourceCli = resolveCliPathIfExternal(sourceRoot, currentScriptPath);
        if (sourceRoot && sourceCli) {
            const packageMetadata = readPackageMetadata(sourceRoot);
            return {
                cli_path: sourceCli,
                root: path.dirname(path.dirname(sourceCli)),
                runtime_kind: 'source_checkout',
                reason: buildDelegationTargetReason(candidate.source, 'source_checkout'),
                package_name: packageMetadata.name || '',
                package_version: packageMetadata.version,
                path_containment: 'validated'
            };
        }

        const bundleRoot = findDeployedBundleRoot(candidate.startDir);
        const bundleCli = resolveCliPathIfExternal(bundleRoot, currentScriptPath);
        if (bundleRoot && bundleCli) {
            const packageMetadata = readPackageMetadata(bundleRoot);
            return {
                cli_path: bundleCli,
                root: path.dirname(path.dirname(bundleCli)),
                runtime_kind: 'deployed_bundle',
                reason: buildDelegationTargetReason(candidate.source, 'deployed_bundle'),
                package_name: packageMetadata.name || '',
                package_version: packageMetadata.version,
                path_containment: 'validated'
            };
        }
    }

    return null;
}

export function resolveDelegatedLauncherTrustEvidence(
    argv: string[],
    cwd: string,
    currentScriptPath: string,
    packageRoot: string
): DelegationTrustEvidence {
    const normalizedPackageRoot = path.resolve(packageRoot);
    const currentRuntimeKind = resolveCurrentRuntimeKind(normalizedPackageRoot, currentScriptPath);
    const installedUnderNodeModules = isPackageInstalledUnderNodeModules(normalizedPackageRoot);
    const packageMetadata = readPackageMetadata(normalizedPackageRoot);
    const delegatedRuntime = resolveDelegatedRuntimeEvidence(argv, cwd, currentScriptPath, normalizedPackageRoot);
    const currentRuntime: CurrentRuntimeEvidence = {
        package_root: normalizedPackageRoot,
        runtime_kind: currentRuntimeKind,
        package_installed_under_node_modules: installedUnderNodeModules,
        recognized_package_name: isRecognizedPackageName(packageMetadata.name),
        package_name: packageMetadata.name,
        package_version: packageMetadata.version
    };

    return buildDelegationTrustEvidence(currentRuntime, delegatedRuntime);
}

export function resolveDelegatedLauncherTarget(
    argv: string[],
    cwd: string,
    currentScriptPath: string,
    packageRoot: string
): string | null {
    const evidence = resolveDelegatedLauncherTrustEvidence(argv, cwd, currentScriptPath, packageRoot);
    return evidence.implementation_delegation.decision === 'allowed'
        ? evidence.delegated_runtime?.cli_path ?? null
        : null;
}

export function getDelegationForwardSignals(platform: NodeJS.Platform = process.platform): NodeJS.Signals[] {
    return platform === 'win32'
        ? ['SIGINT', 'SIGTERM', 'SIGBREAK']
        : ['SIGINT', 'SIGTERM'];
}

export function getDelegationExitCode(status: number | null, signal: NodeJS.Signals | null): number {
    if (status !== null) {
        return status;
    }
    if (signal === 'SIGINT') {
        return 130;
    }
    if (signal === 'SIGTERM') {
        return 143;
    }
    if (signal === 'SIGBREAK') {
        return 149;
    }
    if (signal === 'SIGKILL') {
        return 137;
    }
    return 1;
}

function readDelegationTimeoutMs(): number | null {
    const rawValue = process.env[DELEGATION_TIMEOUT_ENV];
    if (rawValue === undefined || rawValue === '') {
        return null;
    }
    const timeoutMs = Number(rawValue);
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
        throw new Error(`${PRODUCT_NAME} ${DELEGATION_TIMEOUT_ENV} must be a positive integer number of milliseconds.`);
    }
    return timeoutMs;
}

export async function delegateToLocalCli(cliPath: string, argv: string[]): Promise<never> {
    const timeoutMs = readDelegationTimeoutMs();
    const child = childProcess.spawn(process.execPath, [cliPath, ...argv], {
        stdio: 'inherit',
        env: process.env
    });

    const forwardedSignalHandlers = getDelegationForwardSignals().map((signal) => {
        const handler = (): void => {
            child.kill(signal);
        };
        process.once(signal, handler);
        return { signal, handler };
    });

    let timeoutHandle: NodeJS.Timeout | null = null;
    let hardKillHandle: NodeJS.Timeout | null = null;
    if (timeoutMs !== null) {
        timeoutHandle = setTimeout(() => {
            console.error(`${PRODUCT_NAME} delegated CLI timed out after ${timeoutMs}ms; terminating child process.`);
            child.kill('SIGTERM');
            hardKillHandle = setTimeout(() => {
                child.kill('SIGKILL');
            }, DELEGATION_TIMEOUT_KILL_GRACE_MS);
        }, timeoutMs);
    }

    try {
        const result = await new Promise<{ status: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
            child.once('error', reject);
            child.once('close', (status, signal) => {
                resolve({ status, signal });
            });
        });
        process.exit(getDelegationExitCode(result.status, result.signal));
    } finally {
        for (const { signal, handler } of forwardedSignalHandlers) {
            process.removeListener(signal, handler);
        }
        if (timeoutHandle !== null) {
            clearTimeout(timeoutHandle);
        }
        if (hardKillHandle !== null) {
            clearTimeout(hardKillHandle);
        }
    }
    throw new Error(`${PRODUCT_NAME} delegated CLI exited without a terminal status.`);
}

function extractBundleNameArg(argv: string[]): string | null {
    for (let index = 0; index < argv.length; index += 1) {
        const token = argv[index];
        if (token === '--bundle-name') {
            const value = argv[index + 1];
            if (value === undefined || value.startsWith('-')) {
                throw new Error(
                    `${PRODUCT_NAME} --bundle-name requires a deployed bundle directory name value.`
                );
            }
            return value;
        }
        if (token.startsWith('--bundle-name=')) {
            return token.slice('--bundle-name='.length);
        }
    }
    return null;
}

function looksLikeSourceCheckout(packageRoot: string): boolean {
    return fs.existsSync(path.join(packageRoot, '.git'))
        || rootHasAllPaths(packageRoot, SOURCE_CHECKOUT_PROVENANCE_PATHS);
}

export function inferBundleNameFromPackageRoot(packageRoot: string): string | null {
    if (!packageRoot || isPackageInstalledUnderNodeModules(packageRoot)) {
        return null;
    }
    if (!looksLikeDeployedBundleRoot(packageRoot)) {
        return null;
    }
    const parentDir = path.dirname(path.resolve(packageRoot));
    if (!fs.existsSync(path.join(parentDir, 'TASK.md'))) {
        return null;
    }
    const inferredName = path.basename(packageRoot).trim();
    return inferredName ? inferredName : null;
}

export async function main(argv: string[] = process.argv.slice(2), cwd: string = process.cwd()): Promise<void> {
    const bundleNameArg = extractBundleNameArg(argv);
    if (bundleNameArg !== null) {
        process.env.GARDA_BUNDLE_NAME = validateBundleName(bundleNameArg, '--bundle-name');
    }
    const packageRoot = findPackageRoot(__dirname);
    if (process.env.GARDA_BUNDLE_NAME === undefined) {
        const inferredBundleName = inferBundleNameFromPackageRoot(packageRoot);
        if (inferredBundleName) {
            process.env.GARDA_BUNDLE_NAME = validateBundleName(inferredBundleName, 'inferred bundle name');
        }
    }
    const delegatedCli = resolveDelegatedLauncherTarget(argv, cwd, __filename, packageRoot);
    if (delegatedCli) {
        await delegateToLocalCli(delegatedCli, argv);
    }
    const { runCliMainWithHandling } = loadCliMainModule(packageRoot);
    await runCliMainWithHandling(argv, packageRoot);
}

if (require.main === module) {
    void main();
}

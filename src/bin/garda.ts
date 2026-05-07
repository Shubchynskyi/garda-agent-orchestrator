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
const RECOGNIZED_PACKAGE_NAMES = new Set([
    'garda-agent-orchestrator'
]);

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
        try {
            return require(path.join(runtimeRoot, 'cli', 'main.js')) as CliMainModule;
        } catch (error: unknown) {
            lastError = error;
            const hasFallback = index < runtimeCandidates.length - 1;
            if (!hasFallback || !isRecoverableLoadError(error)) {
                throw error;
            }
        }
    }

    throw lastError;
}

function isPackageInstalledUnderNodeModules(packageRoot: string): boolean {
    return path.resolve(packageRoot).split(path.sep).includes('node_modules');
}

function readPackageName(packageRoot: string): string | null {
    const packageJsonPath = path.join(packageRoot, 'package.json');
    if (!fs.existsSync(packageJsonPath)) {
        return null;
    }
    try {
        const parsed = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as { name?: unknown };
        return typeof parsed.name === 'string' ? parsed.name : null;
    } catch (_error) {
        return null;
    }
}

function isGardaPackageRoot(candidateRoot: string): boolean {
    return isRecognizedPackageName(readPackageName(candidateRoot))
        && fs.existsSync(path.join(candidateRoot, 'VERSION'))
        && resolvePreferredCliPath(candidateRoot) !== null;
}

function findSourceCheckoutRoot(startDir: string): string | null {
    let current = path.resolve(startDir);

    while (true) {
        if (isGardaPackageRoot(current)) {
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
        const bundleRoot = path.join(current, effectiveName);
        if (isGardaPackageRoot(bundleRoot)) {
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
        if (!isGardaPackageRoot(candidateRoot)) {
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

function resolveUniqueStartDirs(argv: string[], cwd: string): string[] {
    const candidates = [extractTargetRootArg(argv, cwd), cwd]
        .filter((value): value is string => Boolean(value))
        .map(function (value) { return path.resolve(value); });
    return Array.from(new Set(candidates));
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
    if (candidateRealPath === currentRealPath) {
        return null;
    }

    return candidateCli;
}

export function resolveDelegatedLauncherTarget(
    argv: string[],
    cwd: string,
    currentScriptPath: string,
    packageRoot: string
): string | null {
    if (!isPackageInstalledUnderNodeModules(packageRoot)) {
        return null;
    }

    for (const startDir of resolveUniqueStartDirs(argv, cwd)) {
        const sourceCli = resolveCliPathIfExternal(findSourceCheckoutRoot(startDir), currentScriptPath);
        if (sourceCli) {
            return sourceCli;
        }

        const bundleCli = resolveCliPathIfExternal(findDeployedBundleRoot(startDir), currentScriptPath);
        if (bundleCli) {
            return bundleCli;
        }
    }

    return null;
}

function delegateToLocalCli(cliPath: string, argv: string[]): never {
    const result = childProcess.spawnSync(process.execPath, [cliPath, ...argv], {
        stdio: 'inherit',
        env: process.env
    });

    if (result.error) {
        throw result.error;
    }

    if (result.status !== null) {
        process.exit(result.status);
    }

    process.exit(1);
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
        || fs.existsSync(path.join(packageRoot, 'tests', 'node'))
        || fs.existsSync(path.join(packageRoot, 'scripts', 'node-foundation'));
}

export function inferBundleNameFromPackageRoot(packageRoot: string): string | null {
    if (!packageRoot || isPackageInstalledUnderNodeModules(packageRoot)) {
        return null;
    }
    if (looksLikeSourceCheckout(packageRoot)) {
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
        delegateToLocalCli(delegatedCli, argv);
    }
    const { runCliMainWithHandling } = loadCliMainModule(packageRoot);
    await runCliMainWithHandling(argv, packageRoot);
}

if (require.main === module) {
    void main();
}

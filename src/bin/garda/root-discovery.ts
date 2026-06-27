import * as fs from 'node:fs';
import * as path from 'node:path';

import {
    DEFAULT_BUNDLE_NAME,
    DEPLOYED_BUNDLE_PROVENANCE_PATHS,
    PRIMARY_CLI_ENTRYPOINT,
    RECOGNIZED_PACKAGE_NAMES,
    SOURCE_CHECKOUT_PROVENANCE_PATHS
} from './launcher-constants';

export interface PackageMetadata {
    name: string | null;
    version: string | null;
}

export function resolveBundleName(): string {
    return DEFAULT_BUNDLE_NAME;
}

export function isRecognizedPackageName(value: unknown): boolean {
    const normalized = String(value || '').trim().toLowerCase();
    return normalized !== '' && RECOGNIZED_PACKAGE_NAMES.has(normalized);
}

export function normalizePathForComparison(value: string): string {
    const resolved = path.resolve(value);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

export function isPathInsideOrEqual(parentPath: string, childPath: string): boolean {
    const normalizedParent = normalizePathForComparison(parentPath);
    const normalizedChild = normalizePathForComparison(childPath);
    const relative = path.relative(normalizedParent, normalizedChild);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export function tryRealpath(value: string): string | null {
    try {
        return fs.realpathSync.native(value);
    } catch {
        return null;
    }
}

export function rootHasAllPaths(rootPath: string, relativePaths: readonly string[]): boolean {
    return relativePaths.every((relativePath) => fs.existsSync(path.join(rootPath, relativePath)));
}

export function resolvePreferredCliPath(candidateRoot: string): string | null {
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

export function isPackageInstalledUnderNodeModules(packageRoot: string): boolean {
    return path.resolve(packageRoot).split(path.sep).includes('node_modules');
}

export function readPackageMetadata(packageRoot: string): PackageMetadata {
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

export function isGardaPackageRoot(candidateRoot: string): boolean {
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

export function looksLikeSourceCheckout(packageRoot: string): boolean {
    return fs.existsSync(path.join(packageRoot, '.git'))
        || rootHasAllPaths(packageRoot, SOURCE_CHECKOUT_PROVENANCE_PATHS);
}

export function looksLikeDeployedBundleRoot(packageRoot: string): boolean {
    const normalizedPackageRoot = path.resolve(packageRoot);
    return !isPackageInstalledUnderNodeModules(normalizedPackageRoot)
        && !looksLikeSourceCheckout(normalizedPackageRoot)
        && rootHasAllPaths(normalizedPackageRoot, DEPLOYED_BUNDLE_PROVENANCE_PATHS);
}

export function findSourceCheckoutRoot(startDir: string): string | null {
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

export function findDeployedBundleRoot(startDir: string): string | null {
    const effectiveName = resolveBundleName();
    const current = path.resolve(startDir);

    if (
        path.basename(current) === effectiveName
        && isGardaPackageRoot(current)
        && looksLikeDeployedBundleRoot(current)
    ) {
        return current;
    }

    const bundleRoot = path.join(current, effectiveName);
    return isGardaPackageRoot(bundleRoot) && looksLikeDeployedBundleRoot(bundleRoot)
        ? bundleRoot
        : null;
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

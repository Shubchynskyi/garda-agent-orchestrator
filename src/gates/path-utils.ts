import * as fs from 'node:fs';
import * as path from 'node:path';
import {
    ALL_BUNDLE_NAMES,
    resolveBundleNameForTarget
} from '../core/constants';

export interface ResolvePathOptions {
    allowMissing?: boolean;
    enforceInside?: boolean;
}

/**
 * Normalize a path to Unix-style, trimming whitespace and stripping leading ./
 */
export function normalizePath(pathValue: unknown): string {
    if (pathValue == null) return '';
    let text = String(pathValue).trim().replace(/\\/g, '/');
    text = text.replace(/^\.\//, '');
    text = text.replace(/\/+/g, '/');
    return text;
}

/**
 * Convert any path to POSIX forward-slash style.
 */
export function toPosix(pathValue: unknown): string {
    if (pathValue == null) return '';
    return String(pathValue).replace(/\\/g, '/');
}

/**
 * Resolve project root from a script directory by walking up to find the bundle.
 */
export function resolveProjectRoot(startDir: string): string {
    let current = path.resolve(startDir);
    for (let i = 0; i < 20; i++) {
        if (fs.existsSync(path.join(current, 'MANIFEST.md')) && fs.existsSync(path.join(current, 'VERSION'))) {
            return current;
        }
        const parent = path.dirname(current);
        if (parent === current) break;
        current = parent;
    }
    return path.resolve(startDir);
}

/**
 * Join orchestrator-relative path: if repoRoot already ends with the bundle name
 * use it directly; otherwise prefer a deployed bundle when present and fall back
 * to the workspace root when the bundle has not been materialized yet.
 */
export function joinOrchestratorPath(repoRoot: string, relativePath: string): string {
    const repoRootResolved = path.resolve(repoRoot);
    const effectiveName = resolveBundleNameForTarget(repoRootResolved);
    const deployedRoot = path.resolve(repoRootResolved, effectiveName);
    const looksLikeBundleRoot = (candidatePath: string): boolean => (
        fs.existsSync(path.join(candidatePath, 'MANIFEST.md'))
        && fs.existsSync(path.join(candidatePath, 'VERSION'))
    );

    let orchestratorRoot = repoRootResolved;
    if (looksLikeBundleRoot(deployedRoot)) {
        orchestratorRoot = deployedRoot;
    } else if (looksLikeBundleRoot(repoRootResolved)) {
        orchestratorRoot = repoRootResolved;
    } else if (fs.existsSync(deployedRoot)) {
        orchestratorRoot = deployedRoot;
    }

    let normalizedRelativePath = String(relativePath || '').replace(/\\/g, '/').replace(/^\.\//, '');
    const bundlePrefixes = [...new Set([effectiveName, ...ALL_BUNDLE_NAMES].map((bundleName) => bundleName.toLowerCase()))];
    for (const bundlePrefix of bundlePrefixes) {
        if (normalizedRelativePath.toLowerCase().startsWith(`${bundlePrefix}/`)) {
            normalizedRelativePath = normalizedRelativePath.slice(bundlePrefix.length + 1);
            break;
        }
    }

    if (!normalizedRelativePath.trim()) {
        return path.resolve(orchestratorRoot);
    }
    return path.resolve(orchestratorRoot, normalizedRelativePath);
}

/**
 * Get orchestrator-relative path as a posix string.
 */
export function orchestratorRelativePath(repoRoot: string, relativePath: string): string {
    return toPosix(joinOrchestratorPath(repoRoot, relativePath));
}

export function isPathInsideRoot(pathValue: string, rootPath: string): boolean {
    const resolvedRoot = path.resolve(rootPath);
    const resolvedPath = path.resolve(pathValue);
    const relativePath = path.relative(resolvedRoot, resolvedPath);
    return relativePath === '' || (!!relativePath && !relativePath.startsWith('..') && !path.isAbsolute(relativePath));
}

export function isPathRealpathInsideRoot(
    pathValue: string,
    rootPath: string,
    options: { allowMissing?: boolean } = {}
): boolean {
    const resolvedRoot = path.resolve(rootPath);
    const resolvedPath = path.resolve(pathValue);
    if (!isPathInsideRoot(resolvedPath, resolvedRoot)) {
        return false;
    }
    if (!fs.existsSync(resolvedRoot)) {
        return options.allowMissing === true && !fs.existsSync(resolvedPath);
    }
    let rootRealPath: string;
    try {
        rootRealPath = fs.realpathSync(resolvedRoot);
    } catch {
        return false;
    }
    let probePath = resolvedPath;
    while (!fs.existsSync(probePath)) {
        if (options.allowMissing !== true) {
            return false;
        }
        if (path.resolve(probePath) === resolvedRoot) {
            return true;
        }
        const parentPath = path.dirname(probePath);
        if (parentPath === probePath) {
            return false;
        }
        probePath = parentPath;
    }
    try {
        return isPathInsideRoot(fs.realpathSync(probePath), rootRealPath);
    } catch {
        return false;
    }
}

/**
 * Resolve a path relative to the repo root. If relative, resolve against repoRoot.
 * Pass enforceInside for paths that cross a trust boundary and must remain in the repo.
 */
export function resolvePathInsideRepo(pathValue: string, repoRoot: string, options: ResolvePathOptions = {}): string | null {
    const allowMissing = options.allowMissing || false;
    const enforceInside = options.enforceInside || false;
    const text = String(pathValue).trim();
    if (!text) return null;

    let resolved;
    if (path.isAbsolute(text)) {
        resolved = path.resolve(text);
    } else {
        resolved = path.resolve(repoRoot, text);
    }

    if (enforceInside && !isPathInsideRoot(resolved, repoRoot)) {
        throw new Error(`Path must stay inside repo root: ${resolved}`);
    }

    if (!allowMissing && !fs.existsSync(resolved)) {
        throw new Error(`Path not found: ${resolved}`);
    }

    return resolved;
}

/**
 * Resolve task ID from explicit value or output path hint.
 */
export function resolveTaskId(explicitTaskId: unknown, outputPathHint: unknown): string | null {
    if (explicitTaskId && String(explicitTaskId).trim()) {
        return String(explicitTaskId).trim();
    }
    if (!outputPathHint || !String(outputPathHint).trim()) {
        return null;
    }
    const baseName = path.basename(String(outputPathHint), path.extname(String(outputPathHint)));
    const candidate = baseName.replace(/-preflight$/, '').trim();
    return candidate || null;
}

/**
 * Normalize root prefixes: ensure trailing /, deduplicate, sort.
 */
export function normalizeRootPrefixes(prefixes: unknown[] | null | undefined): string[] {
    const set = new Set<string>();
    for (const prefix of (prefixes || [])) {
        let value = normalizePath(prefix);
        if (!value) continue;
        if (!value.endsWith('/')) value += '/';
        set.add(value);
    }
    return [...set].sort();
}

/**
 * Test if a path starts with any of the given prefixes (case-insensitive).
 */
export function testPathPrefix(pathValue: string, prefixes: string[]): boolean {
    const lower = pathValue.toLowerCase();
    for (const prefix of prefixes) {
        const normalizedPrefix = prefix.toLowerCase();
        if (normalizedPrefix.endsWith('/')) {
            if (lower.startsWith(normalizedPrefix)) return true;
            continue;
        }
        if (lower === normalizedPrefix || lower.startsWith(`${normalizedPrefix}/`)) return true;
    }
    return false;
}

/**
 * Resolve git root from a repo root.
 */
export function resolveGitRoot(repoRoot: string): string {
    const resolved = path.resolve(repoRoot);
    if (fs.existsSync(path.join(resolved, '.git'))) return resolved;
    const bundleCandidate = path.resolve(resolved, resolveBundleNameForTarget(resolved));
    if (fs.existsSync(path.join(bundleCandidate, '.git'))) return bundleCandidate;
    return resolved;
}

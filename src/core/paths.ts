import * as fs from 'node:fs';
import * as path from 'node:path';

export interface RealpathContainmentOptions {
    allowMissing?: boolean;
}

export function getPathModule(platform: string = process.platform): typeof path.win32 | typeof path.posix {
    return platform === 'win32' ? path.win32 : path.posix;
}

export function normalizeRelativePath(value: string): string {
    return String(value).trim().replace(/[\\/]+/g, '/').replace(/^\.\//, '');
}

function normalizeComparisonPath(value: string, platform: string, includeTrailingSeparator: boolean = false): string {
    const pathModule = getPathModule(platform);
    let normalized = pathModule.normalize(pathModule.resolve(String(value)));
    if (includeTrailingSeparator && !normalized.endsWith(pathModule.sep)) {
        normalized += pathModule.sep;
    }

    return platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function pathEntryExists(pathValue: string): boolean {
    try {
        fs.lstatSync(pathValue);
        return true;
    } catch (error: unknown) {
        const errorCode = String((error as NodeJS.ErrnoException)?.code || '');
        return errorCode !== 'ENOENT' && errorCode !== 'ENOTDIR';
    }
}

export function isPathInsideRoot(rootPath: string, candidatePath: string, platform: string = process.platform): boolean {
    const pathModule = getPathModule(platform);
    const resolvedRoot = pathModule.resolve(String(rootPath));
    const resolvedCandidate = pathModule.resolve(String(candidatePath));
    const comparableRoot = normalizeComparisonPath(resolvedRoot, platform, true);
    const comparableCandidate = normalizeComparisonPath(resolvedCandidate, platform, false);

    return comparableCandidate === comparableRoot.slice(0, -1) || comparableCandidate.startsWith(comparableRoot);
}

export function isPathRealpathInsideRoot(
    rootPath: string,
    candidatePath: string,
    options: RealpathContainmentOptions = {}
): boolean {
    const resolvedRoot = path.resolve(rootPath);
    const resolvedCandidate = path.resolve(candidatePath);
    if (!isPathInsideRoot(resolvedRoot, resolvedCandidate)) {
        return false;
    }
    if (!pathEntryExists(resolvedRoot)) {
        return options.allowMissing === true && !pathEntryExists(resolvedCandidate);
    }

    let rootRealPath: string;
    try {
        rootRealPath = fs.realpathSync.native(resolvedRoot);
    } catch {
        return false;
    }

    let existingAncestor = resolvedCandidate;
    while (!pathEntryExists(existingAncestor)) {
        if (options.allowMissing !== true) {
            return false;
        }
        if (path.resolve(existingAncestor) === resolvedRoot) {
            return true;
        }
        const parentPath = path.dirname(existingAncestor);
        if (parentPath === existingAncestor) {
            return false;
        }
        existingAncestor = parentPath;
    }

    try {
        return isPathInsideRoot(rootRealPath, fs.realpathSync.native(existingAncestor));
    } catch {
        return false;
    }
}

export function resolvePathInsideRoot(rootPath: string, candidatePath: string, platform: string = process.platform): string {
    const pathModule = getPathModule(platform);
    const resolvedCandidate = pathModule.resolve(String(rootPath), String(candidatePath));

    if (!isPathInsideRoot(rootPath, resolvedCandidate, platform)) {
        throw new Error(`Resolved path escapes root '${rootPath}': ${candidatePath}`);
    }
    if (platform === process.platform && !isPathRealpathInsideRoot(rootPath, resolvedCandidate, { allowMissing: true })) {
        throw new Error(`Resolved path escapes root through a filesystem link '${rootPath}': ${candidatePath}`);
    }

    return resolvedCandidate;
}

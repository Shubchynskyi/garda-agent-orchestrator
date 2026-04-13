import * as path from 'node:path';

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

export function isPathInsideRoot(rootPath: string, candidatePath: string, platform: string = process.platform): boolean {
    const pathModule = getPathModule(platform);
    const resolvedRoot = pathModule.resolve(String(rootPath));
    const resolvedCandidate = pathModule.resolve(String(candidatePath));
    const comparableRoot = normalizeComparisonPath(resolvedRoot, platform, true);
    const comparableCandidate = normalizeComparisonPath(resolvedCandidate, platform, false);

    return comparableCandidate === comparableRoot.slice(0, -1) || comparableCandidate.startsWith(comparableRoot);
}

export function resolvePathInsideRoot(rootPath: string, candidatePath: string, platform: string = process.platform): string {
    const pathModule = getPathModule(platform);
    const resolvedCandidate = pathModule.resolve(String(rootPath), String(candidatePath));

    if (!isPathInsideRoot(rootPath, resolvedCandidate, platform)) {
        throw new Error(`Resolved path escapes root '${rootPath}': ${candidatePath}`);
    }

    return resolvedCandidate;
}


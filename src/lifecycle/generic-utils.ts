import * as fs from 'node:fs';
import * as path from 'node:path';

function normalizePath(p: string): string {
    return path.resolve(p);
}

export function resolveRealPath(p: string): string {
    const resolved = path.resolve(p);
    try {
        return fs.realpathSync.native(resolved);
    } catch {
        const tail: string[] = [];
        let current = resolved;
        for (;;) {
            const parent = path.dirname(current);
            if (parent === current) {
                return path.join(current, ...tail);
            }
            tail.unshift(path.basename(current));
            current = parent;
            try {
                const realParent = fs.realpathSync.native(current);
                return path.join(realParent, ...tail);
            } catch {
                // Keep walking up.
            }
        }
    }
}

export function isSubpath(parent: string, child: string): boolean {
    const p = normalizePath(parent);
    const c = normalizePath(child);
    if (p === c) return true;
    return c.startsWith(p + path.sep);
}

function isSubpathCaseInsensitive(parent: string, child: string): boolean {
    const p = normalizePath(parent).toLowerCase();
    const c = normalizePath(child).toLowerCase();
    if (p === c) return true;
    return c.startsWith(p + path.sep);
}

function hasCaseVariantSymlinkPrefix(parent: string, child: string): boolean {
    const normalizedParent = normalizePath(parent);
    const normalizedChild = normalizePath(child);
    const parsedParent = path.parse(normalizedParent);
    const parsedChild = path.parse(normalizedChild);

    if (parsedParent.root.toLowerCase() !== parsedChild.root.toLowerCase()) {
        return false;
    }

    const parentSegments = normalizedParent.slice(parsedParent.root.length).split(path.sep).filter(Boolean);
    const childSegments = normalizedChild.slice(parsedChild.root.length).split(path.sep).filter(Boolean);
    const sharedSegments = Math.min(parentSegments.length, childSegments.length);

    for (let index = 0; index < sharedSegments; index += 1) {
        const parentSegment = parentSegments[index];
        const childSegment = childSegments[index];
        if (parentSegment === childSegment) {
            continue;
        }
        if (parentSegment.toLowerCase() !== childSegment.toLowerCase()) {
            return false;
        }

        const candidatePrefix = path.join(parsedChild.root, ...childSegments.slice(0, index + 1));
        try {
            return fs.lstatSync(candidatePrefix).isSymbolicLink();
        } catch {
            return false;
        }
    }

    return false;
}

export function ensureWithinRoot(root: string, candidate: string, description = 'Path'): string {
    const resolved = normalizePath(candidate);
    const resolvedRoot = normalizePath(root);
    const realCandidate = resolveRealPath(resolved);
    const realRoot = resolveRealPath(resolvedRoot);
    const lexicalInsideRoot = isSubpath(resolvedRoot, resolved);
    const caseInsensitiveInsideRoot = isSubpathCaseInsensitive(resolvedRoot, resolved);
    const realInsideRoot = isSubpath(realRoot, realCandidate);

    if (!lexicalInsideRoot && !(caseInsensitiveInsideRoot && realInsideRoot)) {
        throw new Error(`${description} '${candidate}' resolves outside permitted root '${root}'`);
    }

    if (!lexicalInsideRoot && caseInsensitiveInsideRoot && realInsideRoot) {
        if (hasCaseVariantSymlinkPrefix(resolvedRoot, resolved)) {
            throw new Error(`${description} '${candidate}' resolves outside permitted root '${root}'`);
        }
    }

    if (!realInsideRoot) {
        throw new Error(
            `${description} '${candidate}' escapes permitted root '${root}' via symlink or junction`
        );
    }
    return resolved;
}

export function ensureRelativeSafe(rel: string, description = 'Relative path'): void {
    if (path.isAbsolute(rel)) {
        throw new Error(`${description} must be relative, absolute path provided: ${rel}`);
    }
    const norm = path.normalize(rel);
    if (norm.split(path.sep).includes('..')) {
        throw new Error(`${description} contains parent path traversal: ${rel}`);
    }
}

export function compareVersionStrings(current: string, latest: string): number {
    const normalize = (v: string): string => String(v).trim().replace(/^[vV]/, '');
    const a = normalize(current);
    const b = normalize(latest);

    const splitVersion = (value: string): { core: string; prerelease: string } => {
        const noBuild = value.split('+')[0];
        const dashIdx = noBuild.indexOf('-');
        if (dashIdx === -1) return { core: noBuild, prerelease: '' };
        return { core: noBuild.slice(0, dashIdx), prerelease: noBuild.slice(dashIdx + 1) };
    };

    const aParts = splitVersion(a);
    const bParts = splitVersion(b);
    const parseSegments = (value: string): number[] =>
        value.split('.').map((segment) => {
            const match = segment.match(/^(\d+)/);
            return match ? Number(match[1]) : 0;
        });

    const aSegs = parseSegments(aParts.core);
    const bSegs = parseSegments(bParts.core);
    const maxLen = Math.max(aSegs.length, bSegs.length);

    for (let i = 0; i < maxLen; i += 1) {
        const av = i < aSegs.length ? aSegs[i] : 0;
        const bv = i < bSegs.length ? bSegs[i] : 0;
        if (av < bv) return -1;
        if (av > bv) return 1;
    }

    const aPre = aParts.prerelease;
    const bPre = bParts.prerelease;
    if (aPre && !bPre) return -1;
    if (!aPre && bPre) return 1;
    if (aPre && bPre) {
        const aIds = aPre.split('.');
        const bIds = bPre.split('.');
        const len = Math.min(aIds.length, bIds.length);
        for (let i = 0; i < len; i += 1) {
            const ai = aIds[i];
            const bi = bIds[i];
            if (ai === bi) continue;
            const aIsNum = /^\d+$/.test(ai);
            const bIsNum = /^\d+$/.test(bi);
            if (aIsNum && bIsNum) {
                const diff = Number(ai) - Number(bi);
                if (diff < 0) return -1;
                if (diff > 0) return 1;
            } else if (aIsNum) {
                return -1;
            } else if (bIsNum) {
                return 1;
            } else {
                if (ai < bi) return -1;
                if (ai > bi) return 1;
            }
        }
        if (aIds.length < bIds.length) return -1;
        if (aIds.length > bIds.length) return 1;
    }

    return 0;
}

let lastTimestampMs = 0;

export function getTimestamp(): string {
    const currentMs = Date.now();
    const effectiveMs = currentMs <= lastTimestampMs ? lastTimestampMs + 1 : currentMs;
    lastTimestampMs = effectiveMs;

    const now = new Date(effectiveMs);
    const pad2 = (n: number): string => String(n).padStart(2, '0');
    const pad3 = (n: number): string => String(n).padStart(3, '0');
    return (
        `${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}-` +
        `${pad2(now.getHours())}${pad2(now.getMinutes())}${pad2(now.getSeconds())}-` +
        `${pad3(now.getMilliseconds())}`
    );
}

export function copyPathRecursive(sourcePath: string, destinationPath: string): void {
    const stats = fs.lstatSync(sourcePath);
    if (stats.isSymbolicLink()) {
        throw new Error(`Refusing to copy symlink or junction source: ${sourcePath}`);
    }
    const parentDir = path.dirname(destinationPath);
    if (parentDir) fs.mkdirSync(parentDir, { recursive: true });
    if (fs.existsSync(destinationPath) && fs.lstatSync(destinationPath).isSymbolicLink()) {
        throw new Error(`Refusing to overwrite symlink or junction destination: ${destinationPath}`);
    }

    if (!stats.isDirectory()) {
        fs.copyFileSync(sourcePath, destinationPath);
        return;
    }

    const stack: Array<{ src: string; dst: string }> = [{ src: sourcePath, dst: destinationPath }];
    while (stack.length > 0) {
        const { src, dst } = stack.pop()!;
        if (fs.existsSync(dst) && fs.lstatSync(dst).isSymbolicLink()) {
            throw new Error(`Refusing to overwrite symlink or junction destination: ${dst}`);
        }
        fs.mkdirSync(dst, { recursive: true });
        for (const entry of fs.readdirSync(src)) {
            const srcChild = path.join(src, entry);
            const dstChild = path.join(dst, entry);
            const childStats = fs.lstatSync(srcChild);
            if (childStats.isSymbolicLink()) {
                throw new Error(`Refusing to copy symlink or junction source: ${srcChild}`);
            }
            if (fs.existsSync(dstChild) && fs.lstatSync(dstChild).isSymbolicLink()) {
                throw new Error(`Refusing to overwrite symlink or junction destination: ${dstChild}`);
            }
            if (childStats.isDirectory()) {
                stack.push({ src: srcChild, dst: dstChild });
            } else {
                fs.copyFileSync(srcChild, dstChild);
            }
        }
    }
}

export function removePathRecursive(targetPath: string): void {
    if (!fs.existsSync(targetPath)) return;
    fs.rmSync(targetPath, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100
    });
}

export function readdirRecursiveFiles(dirPath: string): string[] {
    const results: string[] = [];
    if (!fs.existsSync(dirPath)) return results;
    const stack: string[] = [dirPath];
    while (stack.length > 0) {
        const current = stack.pop()!;
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
            const full = path.join(current, entry.name);
            if (entry.isDirectory()) {
                stack.push(full);
            } else {
                results.push(full);
            }
        }
    }
    return results;
}

export function readdirRecursiveDirs(dirPath: string): string[] {
    const results: string[] = [];
    if (!fs.existsSync(dirPath)) return results;
    const stack: string[] = [dirPath];
    while (stack.length > 0) {
        const current = stack.pop()!;
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
            const full = path.join(current, entry.name);
            if (entry.isDirectory()) {
                results.push(full);
                stack.push(full);
            }
        }
    }
    return results;
}

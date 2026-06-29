import * as fs from 'node:fs';
import * as path from 'node:path';

export const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function ageCutoff(now: Date, maxAgeDays: number): Date {
    return new Date(now.getTime() - maxAgeDays * MS_PER_DAY);
}

export function directoryEntries(dirPath: string): string[] {
    if (!fs.existsSync(dirPath)) return [];
    try {
        return fs.readdirSync(dirPath).sort();
    } catch {
        return [];
    }
}

export function dirSizeBytes(dirPath: string): number {
    let total = 0;
    try {
        const entries = fs.readdirSync(dirPath, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(dirPath, entry.name);
            if (entry.isDirectory()) {
                total += dirSizeBytes(fullPath);
            } else {
                try {
                    total += fs.statSync(fullPath).size;
                } catch {
                    // unreadable file
                }
            }
        }
    } catch {
        // inaccessible dir
    }
    return total;
}

export function fileSizeBytes(filePath: string): number {
    try {
        return fs.statSync(filePath).size;
    } catch {
        return 0;
    }
}

export function pathStat(entryPath: string): fs.Stats | null {
    try {
        return fs.statSync(entryPath);
    } catch {
        return null;
    }
}

export function cleanupItemSizeBytes(entryPath: string, stat: fs.Stats): number {
    return stat.isDirectory() ? dirSizeBytes(entryPath) : stat.size;
}

export function isNotFoundError(error: unknown): boolean {
    return typeof error === 'object'
        && error !== null
        && 'code' in error
        && (error as { code?: unknown }).code === 'ENOENT';
}

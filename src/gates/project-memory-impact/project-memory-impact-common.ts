import * as fs from 'node:fs';
import { toProjectMemoryPosixPath } from '../../core/project-memory';

export function toRepoPath(value: string): string {
    return toProjectMemoryPosixPath(value).replace(/^\.\//, '');
}

export function uniqueSorted(values: Iterable<string>): string[] {
    return [...new Set([...values].filter(Boolean))].sort();
}

export function readJsonFileIfPresent(filePath: string): unknown | null {
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        return null;
    }
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
        return null;
    }
}

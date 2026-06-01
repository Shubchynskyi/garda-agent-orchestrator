import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolvePathInsideRepo, toPosix } from '../shared/helpers';

export function resolveArtifactPathForRead(pathValue: unknown, repoRoot: string | null): string | null {
    if (pathValue == null) {
        return null;
    }
    const text = String(pathValue).trim();
    if (!text) {
        return null;
    }
    if (repoRoot) {
        try {
            return resolvePathInsideRepo(text, repoRoot, { allowMissing: true });
        } catch {
            return null;
        }
    }
    if (path.isAbsolute(text)) {
        return path.resolve(text);
    }
    return null;
}

export function readJsonArtifactForSummary(
    pathValue: unknown,
    repoRoot: string | null
): { path: string; payload: Record<string, unknown> } | null {
    const resolvedPath = resolveArtifactPathForRead(pathValue, repoRoot);
    if (!resolvedPath) {
        return null;
    }
    try {
        if (!fs.existsSync(resolvedPath) || !fs.statSync(resolvedPath).isFile()) {
            return null;
        }
        return {
            path: toPosix(resolvedPath),
            payload: JSON.parse(fs.readFileSync(resolvedPath, 'utf8'))
        };
    } catch {
        return null;
    }
}

export function safeReadJson(filePath: string): Record<string, unknown> | null {
    try {
        if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
            return null;
        }
        return JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, unknown>;
    } catch {
        return null;
    }
}

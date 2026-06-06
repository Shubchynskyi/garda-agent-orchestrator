import * as childProcess from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import type { ReleaseReadinessCheck } from './types';

export function readTextFileTrimmed(filePath: string): string {
    return fs.readFileSync(filePath, 'utf8').trim();
}

export function readJsonFile(filePath: string): unknown {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

export function normalizeRelativePath(value: string): string {
    return value.split(path.sep).join('/');
}

export function hashFile(filePath: string): string {
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

export function listFiles(rootPath: string): string[] {
    const stat = fs.lstatSync(rootPath);
    if (!stat.isDirectory()) {
        return [rootPath];
    }

    const files: string[] = [];
    const entries = fs.readdirSync(rootPath, { withFileTypes: true });
    for (const entry of entries) {
        const entryPath = path.join(rootPath, entry.name);
        if (entry.isDirectory()) {
            files.push(...listFiles(entryPath));
            continue;
        }
        if (entry.isFile() || entry.isSymbolicLink()) {
            files.push(entryPath);
        }
    }
    return files.sort();
}

export function hashSurfaceItem(itemPath: string): string {
    const hash = crypto.createHash('sha256');
    const stat = fs.lstatSync(itemPath);
    if (!stat.isDirectory()) {
        hash.update('.');
        hash.update('\0');
        hash.update(stat.isSymbolicLink() ? `symlink:${fs.readlinkSync(itemPath)}` : hashFile(itemPath));
        hash.update('\n');
        return hash.digest('hex');
    }

    for (const filePath of listFiles(itemPath)) {
        const fileStat = fs.lstatSync(filePath);
        const relativePath = normalizeRelativePath(path.relative(itemPath, filePath));
        hash.update(relativePath);
        hash.update('\0');
        hash.update(fileStat.isSymbolicLink() ? `symlink:${fs.readlinkSync(filePath)}` : hashFile(filePath));
        hash.update('\n');
    }
    return hash.digest('hex');
}

export function runGit(repoRoot: string, args: string[]): childProcess.SpawnSyncReturns<string> {
    return childProcess.spawnSync('git', args, {
        cwd: repoRoot,
        encoding: 'utf8',
        windowsHide: true
    });
}

export function isGitIgnored(repoRoot: string, relativePath: string): boolean {
    const result = runGit(repoRoot, ['check-ignore', '-q', '--', relativePath]);
    return result.status === 0;
}

export function isGitTracked(repoRoot: string, relativePath: string): boolean {
    const result = runGit(repoRoot, ['ls-files', '--error-unmatch', '--', relativePath]);
    return result.status === 0;
}

export function formatGitFailure(label: string, result: childProcess.SpawnSyncReturns<string>): string {
    const details: string[] = [label];
    if (result.error) {
        details.push(result.error.message);
    }
    if (result.status !== null) {
        details.push(`exit ${result.status}`);
    }
    if (result.signal) {
        details.push(`signal ${result.signal}`);
    }
    const stderr = String(result.stderr || '').trim();
    if (stderr) {
        details.push(stderr);
    }
    const stdout = String(result.stdout || '').trim();
    if (stdout) {
        details.push(stdout);
    }
    return details.join(': ');
}

export function parsePorcelainDirtyPaths(statusOutput: string): string[] {
    return statusOutput
        .split(/\r?\n/u)
        .map((line) => line.trimEnd())
        .filter(Boolean)
        .map((line) => {
            if (line.length <= 3) {
                return line.trim();
            }
            return line.slice(3).trim();
        })
        .filter(Boolean);
}

export function getObjectStringValue(record: Record<string, unknown>, key: string): string | null {
    const value = record[key];
    if (typeof value !== 'string') {
        return null;
    }

    const trimmed = value.trim();
    return trimmed ? trimmed : null;
}

export function readTextFileIfExists(filePath: string): string | null {
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        return null;
    }
    return fs.readFileSync(filePath, 'utf8');
}

export function readPackageJsonObject(repoRoot: string, violations: string[]): Record<string, unknown> | null {
    const packageJsonPath = path.join(repoRoot, 'package.json');
    if (!fs.existsSync(packageJsonPath)) {
        violations.push(`Missing package.json: ${packageJsonPath}`);
        return null;
    }

    const payload = readJsonFile(packageJsonPath);
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
        violations.push(`package.json must contain an object: ${packageJsonPath}`);
        return null;
    }

    return payload as Record<string, unknown>;
}

export function getStringRecord(value: unknown): Record<string, string> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return {};
    }

    const output: Record<string, string> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
        if (typeof entry === 'string') {
            output[key] = entry;
        }
    }
    return output;
}

export function getStringArray(value: unknown): string[] {
    if (!Array.isArray(value)) {
        return [];
    }
    return value.filter((entry): entry is string => typeof entry === 'string');
}

export function countOccurrences(value: string, needle: string): number {
    if (!needle) {
        return 0;
    }
    return value.split(needle).length - 1;
}

export function pushCheck(
    checks: ReleaseReadinessCheck[],
    violations: string[],
    area: string,
    label: string,
    passed: boolean,
    details: string[]
): void {
    checks.push({ area, label, passed, details });
    if (!passed) {
        violations.push(`${area}: ${label}`);
    }
}

export function fileExists(repoRoot: string, relativePath: string): boolean {
    const resolvedPath = path.join(repoRoot, ...relativePath.split('/'));
    return fs.existsSync(resolvedPath);
}

export function manifestListsEvery(manifestText: string, relativePaths: readonly string[]): boolean {
    return relativePaths.every((relativePath) => manifestText.includes(relativePath));
}

export function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

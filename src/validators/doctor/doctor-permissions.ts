import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveBundleName } from '../../core/constants';

export interface PermissionCheckEvidence {
    passed: boolean;
    checks: PermissionCheckEntry[];
}

export interface PermissionCheckEntry {
    path: string;
    kind: 'read' | 'write';
    exists: boolean;
    accessible: boolean;
    error: string | null;
}

const CRITICAL_WRITABLE_RELATIVE_PATHS: readonly string[] = [
    resolveBundleName() + '/runtime',
    resolveBundleName() + '/live/config'
];

const CRITICAL_READABLE_RELATIVE_PATHS: readonly string[] = [
    resolveBundleName() + '/VERSION',
    resolveBundleName() + '/MANIFEST.md'
];

export function checkPermissions(targetRoot: string): PermissionCheckEvidence {
    const checks: PermissionCheckEntry[] = [];

    for (const relPath of CRITICAL_WRITABLE_RELATIVE_PATHS) {
        const absPath = path.join(targetRoot, relPath);
        const entry: PermissionCheckEntry = {
            path: relPath,
            kind: 'write',
            exists: false,
            accessible: false,
            error: null
        };
        try {
            entry.exists = fs.existsSync(absPath);
            if (entry.exists) {
                fs.accessSync(absPath, fs.constants.W_OK);
                entry.accessible = true;
            } else {
                // Parent must be writable for directory creation
                const parentPath = path.dirname(absPath);
                if (fs.existsSync(parentPath)) {
                    fs.accessSync(parentPath, fs.constants.W_OK);
                    entry.accessible = true;
                } else {
                    entry.error = 'Parent directory does not exist: ' + parentPath;
                }
            }
        } catch (err: unknown) {
            entry.error = getErrorMessage(err);
        }
        checks.push(entry);
    }

    for (const relPath of CRITICAL_READABLE_RELATIVE_PATHS) {
        const absPath = path.join(targetRoot, relPath);
        const entry: PermissionCheckEntry = {
            path: relPath,
            kind: 'read',
            exists: false,
            accessible: false,
            error: null
        };
        try {
            entry.exists = fs.existsSync(absPath);
            if (entry.exists) {
                fs.accessSync(absPath, fs.constants.R_OK);
                entry.accessible = true;
            }
        } catch (err: unknown) {
            entry.error = getErrorMessage(err);
        }
        checks.push(entry);
    }

    const passed = checks.every(function (c) {
        return !c.exists || c.accessible;
    });

    return { passed, checks };
}

function getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

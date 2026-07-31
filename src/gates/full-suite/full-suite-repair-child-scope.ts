import * as path from 'node:path';

import {
    isPathRealpathInsideRoot
} from '../../core/paths';
import type {
    RepairChildScopeEvidence
} from './full-suite-repair-contracts';
import {
    normalizeGitPath
} from './full-suite-repair-contracts';

const REPAIR_SCOPE_MARKER = 'repair scope paths:';
const BACKTICK_VALUE_PATTERN = /`([^`\r\n|]+)`/gu;
const GLOB_PATTERN = /[*?[\]{}]/u;

export function hasRepairChildScopeDeclaration(notes: string | null): boolean {
    return String(notes || '').toLowerCase().includes(REPAIR_SCOPE_MARKER);
}

function normalizeScopePath(repoRoot: string, value: unknown, label: string): {
    path: string | null;
    violations: string[];
} {
    const rawValue = typeof value === 'string' ? value.trim() : '';
    const normalized = normalizeGitPath(rawValue);
    const segments = normalized.split('/');
    const violations: string[] = [];
    if (
        !rawValue
        || rawValue !== normalized
        || normalized === '.'
        || normalized.endsWith('/')
        || segments.some((segment) => !segment || segment === '.' || segment === '..')
        || normalized.startsWith('-')
        || path.isAbsolute(rawValue)
        || /^[A-Za-z]:[\\/]/u.test(rawValue)
        || /[\u0000-\u001F\u007F]/u.test(rawValue)
        || GLOB_PATTERN.test(rawValue)
    ) {
        violations.push(
            `${label} must be an exact canonical repository-relative file path without glob syntax: ${rawValue || '<empty>'}.`
        );
        return { path: null, violations };
    }
    const resolved = path.resolve(repoRoot, normalized);
    const root = path.resolve(repoRoot);
    const relative = path.relative(root, resolved);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        violations.push(`${label} escapes repository root: ${rawValue}.`);
        return { path: null, violations };
    }
    if (!isPathRealpathInsideRoot(root, resolved, { allowMissing: true })) {
        violations.push(
            `${label} physically escapes repository root through a symbolic-link or junction component: ${rawValue}.`
        );
        return { path: null, violations };
    }
    return { path: normalized, violations };
}

export function readRepairChildScopeFromNotes(
    repoRoot: string,
    taskId: string,
    notes: string | null
): {
    scope: RepairChildScopeEvidence | null;
    violations: string[];
} {
    const text = String(notes || '');
    const markerIndex = text.toLowerCase().indexOf(REPAIR_SCOPE_MARKER);
    if (markerIndex < 0) {
        return {
            scope: null,
            violations: [
                `repair child ${taskId} must declare exact file boundaries in Notes using `
                + '`Repair scope paths: `path/one`, `path/two`;`.'
            ]
        };
    }
    const valueStart = markerIndex + REPAIR_SCOPE_MARKER.length;
    const terminatorIndex = text.indexOf(';', valueStart);
    if (terminatorIndex < 0) {
        return {
            scope: null,
            violations: [`repair child ${taskId} Repair scope paths declaration must end with a semicolon.`]
        };
    }
    const declaration = text.slice(valueStart, terminatorIndex);
    const rawPaths: string[] = [];
    let match: RegExpExecArray | null;
    BACKTICK_VALUE_PATTERN.lastIndex = 0;
    while ((match = BACKTICK_VALUE_PATTERN.exec(declaration)) !== null) {
        rawPaths.push(match[1]);
    }
    const residue = declaration.replace(BACKTICK_VALUE_PATTERN, '').replace(/[\s,]/gu, '');
    const violations: string[] = [];
    if (residue || rawPaths.length === 0) {
        violations.push(
            `repair child ${taskId} Repair scope paths must be a non-empty comma-separated list of backticked exact paths.`
        );
    }
    const normalizedPaths: string[] = [];
    rawPaths.forEach((rawPath, index) => {
        const normalized = normalizeScopePath(
            repoRoot,
            rawPath,
            `repair child ${taskId} scope path[${index}]`
        );
        violations.push(...normalized.violations);
        if (normalized.path) {
            normalizedPaths.push(normalized.path);
        }
    });
    if (new Set(normalizedPaths).size !== normalizedPaths.length) {
        violations.push(`repair child ${taskId} scope paths must be unique.`);
    }
    return violations.length > 0
        ? { scope: null, violations }
        : {
            scope: {
                task_id: taskId,
                paths: normalizedPaths
            },
            violations: []
        };
}

export function parseRepairChildScopeEvidence(
    repoRoot: string,
    value: unknown,
    expectedTaskIds: readonly string[],
    label: string
): {
    scopes: RepairChildScopeEvidence[] | null;
    violations: string[];
} {
    if (!Array.isArray(value)) {
        return { scopes: null, violations: [`${label} must be an array.`] };
    }
    const violations: string[] = [];
    const scopes: RepairChildScopeEvidence[] = [];
    value.forEach((entry, index) => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
            violations.push(`${label}[${index}] must be an object.`);
            return;
        }
        const record = entry as Record<string, unknown>;
        const keys = Object.keys(record);
        if (keys.length !== 2 || !keys.includes('task_id') || !keys.includes('paths')) {
            violations.push(`${label}[${index}] must contain only task_id and paths.`);
        }
        const taskId = typeof record.task_id === 'string' ? record.task_id.trim() : '';
        if (!taskId || record.task_id !== taskId || /[\u0000-\u001F\u007F]/u.test(taskId)) {
            violations.push(`${label}[${index}].task_id must be a non-empty canonical string.`);
        }
        if (!Array.isArray(record.paths) || record.paths.length === 0) {
            violations.push(`${label}[${index}].paths must be a non-empty array.`);
            return;
        }
        const normalizedPaths: string[] = [];
        record.paths.forEach((entryPath, pathIndex) => {
            const normalized = normalizeScopePath(
                repoRoot,
                entryPath,
                `${label}[${index}].paths[${pathIndex}]`
            );
            violations.push(...normalized.violations);
            if (normalized.path) {
                normalizedPaths.push(normalized.path);
            }
        });
        if (new Set(normalizedPaths).size !== normalizedPaths.length) {
            violations.push(`${label}[${index}].paths must contain unique entries.`);
        }
        scopes.push({ task_id: taskId, paths: normalizedPaths });
    });
    if (
        scopes.length !== expectedTaskIds.length
        || scopes.some((scope, index) => scope.task_id !== expectedTaskIds[index])
    ) {
        violations.push(`${label} task ids must exactly match the ordered repair child_task_ids.`);
    }
    violations.push(...validateIndependentRepairChildScopes(scopes));
    return violations.length > 0
        ? { scopes: null, violations }
        : { scopes, violations: [] };
}

export function validateIndependentRepairChildScopes(
    scopes: readonly RepairChildScopeEvidence[]
): string[] {
    const violations: string[] = [];
    const owners = new Map<string, string>();
    for (const scope of scopes) {
        if (scope.paths.length === 0) {
            violations.push(`repair child ${scope.task_id} scope must not be empty.`);
        }
        for (const scopePath of scope.paths) {
            const priorOwner = owners.get(scopePath);
            if (priorOwner && priorOwner !== scope.task_id) {
                violations.push(
                    `repair child scopes overlap at ${scopePath}: ${priorOwner}, ${scope.task_id}.`
                );
            } else {
                owners.set(scopePath, scope.task_id);
            }
        }
    }
    if (scopes.length >= 2) {
        const unionSize = owners.size;
        for (const scope of scopes) {
            if (scope.paths.length >= unionSize) {
                violations.push(
                    `repair child ${scope.task_id} scope is not strictly smaller than the combined repair scope.`
                );
            }
        }
    }
    return violations;
}

export function validateRepairChildScopeIsolation(
    scopes: readonly RepairChildScopeEvidence[],
    suspendedWipPaths: readonly string[]
): string[] {
    const suspended = new Set(suspendedWipPaths.map((entry) => normalizeGitPath(entry)));
    const violations: string[] = [];
    for (const scope of scopes) {
        const overlaps = scope.paths.filter((scopePath) => suspended.has(scopePath));
        if (overlaps.length > 0) {
            violations.push(
                `repair child ${scope.task_id} scope overlaps suspended parent WIP: ${overlaps.join(', ')}.`
            );
        }
    }
    return violations;
}

export function validateRepairChildChangedFiles(
    scopes: readonly RepairChildScopeEvidence[],
    childTaskId: string,
    changedFiles: readonly string[]
): string[] {
    const scope = scopes.find((entry) => entry.task_id === childTaskId);
    if (!scope) {
        return [`scoped repair handoff does not contain child ${childTaskId}.`];
    }
    const allowed = new Set(scope.paths);
    const normalizedChangedFiles = [...new Set(
        changedFiles.map((entry) => normalizeGitPath(entry)).filter(Boolean)
    )].sort();
    const outOfScope = normalizedChangedFiles.filter((entry) => !allowed.has(entry));
    return outOfScope.length > 0
        ? [
            `repair child ${childTaskId} changed files outside its immutable scoped handoff: `
            + `${outOfScope.join(', ')}; allowed: ${scope.paths.join(', ')}.`
        ]
        : [];
}

export function sameRepairChildScopes(
    left: readonly RepairChildScopeEvidence[],
    right: readonly RepairChildScopeEvidence[]
): boolean {
    return left.length === right.length
        && left.every((scope, index) => (
            scope.task_id === right[index]?.task_id
            && scope.paths.length === right[index].paths.length
            && scope.paths.every((scopePath, pathIndex) => scopePath === right[index].paths[pathIndex])
        ));
}
